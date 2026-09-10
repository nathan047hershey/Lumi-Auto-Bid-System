/**
 * Detect + fill application forms (Autofill Engineer v3 backend).
 * Greenhouse, Lever, Workday, Ashby, Oracle, iCIMS, SmartRecruiters, BambooHR, generic.
 * Salary is filled when the JD (or profile) has a parseable range.
 * LinkedIn Easy Apply is skipped.
 */
(() => {
    if (window.__JOB_APPLY_BIDDER_FILL__) return;
    window.__JOB_APPLY_BIDDER_FILL__ = true;

    /** False after Reload Lumi — orphaned content scripts must stop quietly. */
    function extensionContextValid() {
        try {
            return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
        } catch (_) {
            return false;
        }
    }

    function isExtensionContextError(err) {
        return /extension context invalidated/i.test(String(err?.message || err || ''));
    }

    function safeRuntimeSend(message, callback) {
        if (!extensionContextValid()) {
            if (typeof callback === 'function') {
                try { callback({ ok: false, error: 'Extension reloaded — refresh this tab' }); } catch (_) { /* ignore */ }
            }
            return;
        }
        try {
            chrome.runtime.sendMessage(message, (res) => {
                const lastErr = chrome.runtime.lastError;
                if (lastErr) {
                    if (typeof callback === 'function') {
                        try { callback({ ok: false, error: lastErr.message }); } catch (_) { /* ignore */ }
                    }
                    return;
                }
                if (typeof callback === 'function') callback(res);
            });
        } catch (err) {
            if (typeof callback === 'function') {
                try {
                    callback({
                        ok: false,
                        error: isExtensionContextError(err)
                            ? 'Extension reloaded — refresh this tab'
                            : (err?.message || String(err))
                    });
                } catch (_) { /* ignore */ }
            }
        }
    }

    const SALARY_RE = /\b(salary|compensation|pay|ctc|base\s*pay|expected\s*comp|wage|remuneration)\b/i;
    /** Yes/No “comfortable with outlined salary?” — not an expected-$ field. */
    const SALARY_COMFORT_YES_RE =
        /\b(comfortable|willing)\b.{0,80}\b(salary|compensation|pay)\b|\b(salary|compensation)\b.{0,40}\boutlined\b|\b(agree|accept)\b.{0,60}\b(salary|compensation)\b.{0,40}\b(range|outlined|posted|listed|job\s*description)\b/i;

    function isSalaryComfortYesNo(label, name = '', autoId = '') {
        const hay = `${label || ''} ${name || ''} ${autoId || ''}`;
        if (!SALARY_RE.test(hay)) return false;
        return SALARY_COMFORT_YES_RE.test(hay)
            || (/\b(are you|do you)\b/i.test(hay) && /\bcomfortable\b/i.test(hay));
    }
    const MONEY_TOKEN =
        /(?:\$|USD|CAD|EUR|GBP|£|€)?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|K|m|M)?/g;

    function toAnnualNumber(raw, suffix, nearbyText = '') {
        let n = parseFloat(String(raw).replace(/,/g, ''));
        if (!Number.isFinite(n) || n <= 0) return null;
        const suf = (suffix || '').toLowerCase();
        if (suf === 'k') n *= 1000;
        if (suf === 'm') n *= 1000000;
        const ctx = String(nearbyText || '').toLowerCase();
        if (/\b(per\s*hour|\/\s*hr|\/\s*hour|hourly)\b/.test(ctx) && n < 500) {
            n = Math.round(n * 2080);
        }
        if (!suf && n >= 40 && n <= 500 && /\b(salary|compensation|base|pay|ctc|range|usd|\$)\b/i.test(ctx)) {
            n *= 1000;
        }
        return Math.round(n);
    }

    function extractMoneyAmounts(text) {
        const src = String(text || '');
        const amounts = [];
        MONEY_TOKEN.lastIndex = 0;
        let m;
        while ((m = MONEY_TOKEN.exec(src)) !== null) {
            const start = Math.max(0, m.index - 40);
            const end = Math.min(src.length, m.index + m[0].length + 40);
            const nearby = src.slice(start, end);
            const n = toAnnualNumber(m[1], m[2], nearby);
            if (n && n >= 15000 && n <= 2000000) {
                amounts.push({ value: n, index: m.index });
            }
        }
        return amounts;
    }

    function parseRangeFromText(text) {
        const src = String(text || '');
        if (!src.trim()) return null;
        const rangeRes = [
            /(?:\$|USD)?\s*([\d,.]+)\s*(k|K)?\s*(?:-|–|—|to|and)\s*(?:\$|USD)?\s*([\d,.]+)\s*(k|K)?/gi,
            /between\s+(?:\$|USD)?\s*([\d,.]+)\s*(k|K)?\s+and\s+(?:\$|USD)?\s*([\d,.]+)\s*(k|K)?/gi
        ];
        const candidates = [];
        for (const re of rangeRes) {
            let m;
            while ((m = re.exec(src)) !== null) {
                const nearby = src.slice(Math.max(0, m.index - 60), Math.min(src.length, m.index + m[0].length + 60));
                const a = toAnnualNumber(m[1], m[2], nearby);
                const b = toAnnualNumber(m[3], m[4], nearby);
                if (a && b) {
                    const lo = Math.min(a, b);
                    const hi = Math.max(a, b);
                    if (hi > lo && hi / lo < 8) {
                        candidates.push({
                            min: lo,
                            max: hi,
                            score: /salary|compensation|pay|ctc|base|range/i.test(nearby) ? 2 : 1
                        });
                    }
                }
            }
        }
        if (candidates.length) {
            candidates.sort((x, y) => y.score - x.score || (y.max - y.min) - (x.max - x.min));
            return { min: candidates[0].min, max: candidates[0].max };
        }
        const amounts = extractMoneyAmounts(src);
        for (let i = 0; i < amounts.length - 1; i++) {
            const a = amounts[i];
            const b = amounts[i + 1];
            if (Math.abs(b.index - a.index) > 80) continue;
            const lo = Math.min(a.value, b.value);
            const hi = Math.max(a.value, b.value);
            if (hi > lo && hi / lo < 5) return { min: lo, max: hi };
        }
        if (amounts.length === 1) {
            const v = amounts[0].value;
            return { min: v, max: v };
        }
        // Bare profile values like "180000" or "180k"
        const bare = String(src || '').trim();
        const bareM = bare.match(/^\$?\s*([\d,]+)\s*(k|K)?$/);
        if (bareM) {
            const n = toAnnualNumber(bareM[1], bareM[2], bare);
            if (n && n >= 15000 && n <= 2000000) return { min: n, max: n };
        }
        return null;
    }

    function formatSalary(n, style = 'usd') {
        const num = Number(n);
        if (!Number.isFinite(num) || num < 15000) return '';
        const rounded = Math.round(num / 1000) * 1000;
        if (style === 'number') return String(rounded);
        if (style === 'k') return `${Math.round(rounded / 1000)}k`;
        return `$${rounded.toLocaleString('en-US')}`;
    }

    function inferJobSalaryBand({ jobDescription = '', jobRole = '', companyName = '' } = {}) {
        const hay = `${jobRole || ''} ${companyName || ''} ${String(jobDescription || '').slice(0, 4000)}`.toLowerCase();
        let mid = 145000;
        if (/\b(intern|internship|co[\s-]?op)\b/.test(hay)) mid = 75000;
        else if (/\b(junior|entry[\s-]?level|associate|new grad|graduate)\b/.test(hay)) mid = 105000;
        else if (/\b(distinguished|fellow|vp\b|vice president|head of)\b/.test(hay)) mid = 240000;
        else if (/\b(principal|staff)\b/.test(hay)) mid = 215000;
        else if (/\b(senior|sr\.?|lead)\b/.test(hay)) mid = 175000;
        else if (/\b(manager|director)\b/.test(hay)) mid = 190000;
        else if (/\b(mid[\s-]?level|ii\b|2\b)\b/.test(hay)) mid = 140000;
        if (/\b(machine learning|ml engineer|ai engineer|security|cryptograph|platform|sre|devops|infrastructure|data engineer)\b/.test(hay)) {
            mid = Math.round(mid * 1.08);
        }
        if (/\b(frontend|react|ui engineer|support|qa|quality assurance|manual test)\b/.test(hay)) {
            mid = Math.round(mid * 0.95);
        }
        if (/\b(san francisco|bay area|nyc|new york city|seattle|redmond|cupertino|palo alto|mountain view)\b/.test(hay)) {
            mid = Math.round(mid * 1.1);
        } else if (/\b(remote|anywhere|midwest|texas|florida|ohio|georgia|north carolina)\b/.test(hay)) {
            mid = Math.round(mid * 0.94);
        }
        mid = Math.max(70000, Math.min(350000, mid));
        let hash = 0;
        const key = `${jobRole}|${companyName}|${String(jobDescription || '').slice(0, 240)}`;
        for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
        const jitter = ((Math.abs(hash) % 11) - 5) * 1000;
        mid = Math.max(70000, mid + jitter);
        const spread = Math.round(mid * 0.1);
        return { min: mid - spread, max: mid + spread };
    }

    function pickSalaryExpectation({
        jobDescription,
        profileSalaryRange,
        fieldLabel = '',
        jobRole = '',
        companyName = ''
    } = {}) {
        const jdRange = parseRangeFromText(jobDescription);
        const profileRange = parseRangeFromText(profileSalaryRange);
        const jobBand = (!jdRange)
            ? inferJobSalaryBand({ jobDescription, jobRole, companyName })
            : null;
        let min;
        let max;
        let source;
        if (jdRange && profileRange) {
            const lo = Math.max(jdRange.min, profileRange.min);
            const hi = Math.min(jdRange.max, profileRange.max);
            if (lo <= hi) {
                min = lo;
                max = hi;
                source = 'jd_profile_overlap';
            } else {
                min = jdRange.min;
                max = jdRange.max;
                source = 'jd_mid_low';
            }
        } else if (jdRange) {
            min = jdRange.min;
            max = jdRange.max;
            source = 'jd_only';
        } else if (jobBand && profileRange) {
            min = jobBand.min;
            max = jobBand.max;
            const jobMid = (jobBand.min + jobBand.max) / 2;
            const profMid = (profileRange.min + profileRange.max) / 2;
            if (Math.abs(jobMid - profMid) > 80000) {
                min = Math.round((jobBand.min + profileRange.min) / 2);
                max = Math.round((jobBand.max + profileRange.max) / 2);
            }
            source = 'job_inferred_blend';
        } else if (jobBand) {
            min = jobBand.min;
            max = jobBand.max;
            source = 'job_inferred';
        } else if (profileRange) {
            min = profileRange.min;
            max = profileRange.max;
            source = 'profile_only';
        } else if (profileSalaryRange && String(profileSalaryRange).trim()) {
            const raw = String(profileSalaryRange).trim();
            if (/^\$?\s*0+\s*$/.test(raw)) return null;
            return { value: null, formatted: raw, source: 'profile_raw' };
        } else {
            min = 120000;
            max = 160000;
            source = 'default_mid';
        }
        const value = Math.round(min + (max - min) * 0.35);
        if (!Number.isFinite(value) || value < 15000) return null;
        const label = String(fieldLabel || '').toLowerCase();
        let style = 'usd';
        if (/\b(k|thousand)\b/.test(label)) style = 'k';
        if (/\b(amount|number|usd\s*only|numeric)\b/.test(label)) style = 'number';
        const formatted = formatSalary(value, style);
        if (!formatted) return null;
        return { value, formatted, source };
    }

    function matchSalaryOption(options, pick) {
        if (!pick || !options?.length) return null;
        let target = pick.value;
        if (target == null || typeof target === 'string') {
            const fromPick = extractMoneyAmounts(String(pick.formatted || pick.value || ''));
            if (fromPick.length) target = fromPick[0].value;
            else if (typeof target === 'string' && /^\d+(\.\d+)?$/.test(target.trim())) {
                target = Number(target);
            }
        }
        if (target == null || !Number.isFinite(Number(target))) return null;
        target = Number(target);
        let best = null;
        let bestScore = -Infinity;
        let foundMoney = false;
        for (const opt of options) {
            const text = String(opt.text || opt.label || '').trim()
                || String(opt.value || '').trim();
            if (!text || /^select(\s|\.|…|\.\.\.|:)?$/i.test(text)) continue;
            // Prefer visible option text over compact values like "60-80" / "70k".
            const range = parseRangeFromText(text)
                || (opt.value && opt.value !== text ? parseRangeFromText(String(opt.value)) : null);
            let score = null;
            if (range && range.max >= 1000) {
                foundMoney = true;
                if (target >= range.min && target <= range.max) {
                    const mid = (range.min + range.max) / 2;
                    const half = Math.max((range.max - range.min) / 2, 1);
                    score = 1000 - (Math.abs(mid - target) / half) * 350;
                } else {
                    const dist = target < range.min
                        ? range.min - target
                        : target - range.max;
                    // Closest band always wins among out-of-range options.
                    score = 400 - Math.min(dist, 1e6) / 1000;
                }
            } else {
                const amounts = extractMoneyAmounts(text);
                if (amounts.length) {
                    foundMoney = true;
                    score = 300 - Math.abs(amounts[0].value - target) / 1000;
                }
            }
            if (score != null && score > bestScore) {
                bestScore = score;
                best = opt;
            }
        }
        return foundMoney && best ? best : null;
    }

    function detectAts() {
        const host = (window.__BIDDER_SPOOF_HOST || location.hostname || '').toLowerCase();
        const href = (window.__BIDDER_SPOOF_HREF || location.href || '').toLowerCase();
        if (host.includes('linkedin.com') || href.includes('linkedin.com/jobs')) {
            return 'linkedin';
        }
        // Prefer hostname when present (tests + real ATS URLs) before generic DOM hints.
        if (host.includes('greenhouse.io') || host.includes('boards.greenhouse') || host.includes('job-boards.greenhouse')) {
            return 'greenhouse';
        }
        if (host.includes('lever.co') || host.includes('jobs.lever.co')) {
            return 'lever';
        }
        if (host.includes('ashbyhq.com') || host.includes('jobs.ashbyhq.com')) {
            return 'ashby';
        }
        if (
            host.includes('myworkdayjobs.com')
            || host.includes('workdayjobs.com')
            || host.includes('wd1.myworkdayjobs')
            || host.includes('wd5.myworkdayjobs')
        ) {
            return 'workday';
        }
        if (host.includes('smartrecruiters.com')) {
            return 'smartrecruiters';
        }
        if (host.includes('icims.com')) {
            return 'icims';
        }
        if (host.includes('bamboohr.com')) {
            return 'bamboohr';
        }
        if (host.includes('rippling.com') || host.includes('ats.rippling')) {
            return 'rippling';
        }
        if (
            host.includes('oraclecloud.com')
            || host.includes('.oracle.com/hcm')
            || /fa\.[a-z0-9]+\.oraclecloud\.com/i.test(host)
        ) {
            return 'oracle';
        }
        if (
            document.querySelector('#greenhouse-job-application, [data-provider="Greenhouse"]')
        ) {
            return 'greenhouse';
        }
        if (
            document.querySelector(
                'form.application-form, #application-form, .main-header-text.apply, [data-qa="btn-submit"]'
            )
        ) {
            return 'lever';
        }
        if (
            document.querySelector('[class*="ashby"], [data-testid*="ashby"], #ashby_embed.ashby-application-form, .ashby-application-form')
        ) {
            return 'ashby';
        }
        if (
            document.querySelector(
                '[data-automation-id="jobPostingPage"], [data-automation-id="applyManually"], '
                + '[data-automation-id="contactInfoSection"], [data-automation-id="formField-legalName"], '
                + '[data-automation-id="formField-email"], [data-automation-id="bottom-submit"]'
            )
        ) {
            return 'workday';
        }
        if (
            document.querySelector('.jobapp-form, [class*="smartrecruiters"], #st-jobApplicationForm')
        ) {
            return 'smartrecruiters';
        }
        if (
            document.querySelector('.iCIMS_Forms, #icims_content_iframe, [class*="iCIMS"]')
        ) {
            return 'icims';
        }
        if (
            document.querySelector('.BambooHR-ATS-board, #bhrApplicantForm')
        ) {
            return 'bamboohr';
        }
        if (
            document.querySelector(
                '[data-automation-id*="oracle"], .apply-flow-page, .job-application-form, '
                + 'input[name*="candidate"], form[action*="oraclecloud"]'
            )
            || /oraclecloud|oracle\.com\/hcm/i.test(location.href)
        ) {
            return 'oracle';
        }
        return 'generic';
    }

    function visible(el) {
        if (!el || el.disabled) return false;
        const type = String(el.type || '').toLowerCase();
        const isSelectInput = !!(
            el.getAttribute('role') === 'combobox'
            || el.getAttribute('aria-autocomplete')
            || /select__input|react-select/i.test(String(el.className || ''))
            || el.closest('.select__control, .select__container, [class*="select__control"]')
        );
        // Greenhouse / Rippling hide native radios, checkboxes, and file inputs
        // (opacity 0 or display:none) inside a visible custom dropzone / toggle.
        const isFile = type === 'file';
        const isOpaqueControl = type === 'radio' || type === 'checkbox' || isFile || isSelectInput;
        const style = window.getComputedStyle(el);
        if (isFile) {
            const wrap = el.closest(
                'label, [class*="drop"], [class*="upload"], [class*="file"], [class*="attach"], '
                + 'fieldset, .field, .form-field, [class*="Field"], [class*="Document"]'
            ) || el.parentElement;
            if (wrap) {
                const cr = wrap.getBoundingClientRect();
                if (cr.width > 4 && cr.height > 4) return true;
            }
        }
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (!isOpaqueControl && Number(style.opacity) === 0) return false;
        if (isOpaqueControl) {
            const control = el.closest(
                '.select__control, [class*="select__control"], label, .field, .form-field, fieldset, [class*="question"], [class*="upload"], [class*="file"]'
            ) || el.parentElement;
            if (control) {
                const cr = control.getBoundingClientRect();
                if (cr.width > 0 && cr.height > 0) return true;
            }
        }
        if (el.readOnly && !isSelectInput) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 || rect.height > 0 || type === 'radio' || type === 'checkbox' || type === 'file';
    }

    function radioGroupQuestionLabel(group) {
        const first = group[0];
        if (!first) return '';
        const container = first.closest(
            'fieldset, .field, .form-field, .application-field, .application-question, [class*="question"], '
            + '[data-qa], .ashby-application-form-field-entry, .form-group, [class*="ApplicationField"], [data-ui]'
        );
        if (container) {
            const legend = container.querySelector('legend');
            if (legend) {
                const t = (legend.innerText || legend.textContent || '').trim();
                if (t.length > 8) return t;
            }
            const leverText = container.querySelector?.(
                '.application-label .text, .application-label, h4[data-qa="card-name"]'
            );
            if (leverText && !leverText.querySelector('input')) {
                const t = (leverText.innerText || leverText.textContent || '').trim();
                if (t.length > 8) return t.split('\n')[0].trim();
            }
            // Prefer labels that wrap the question, not the radio option itself.
            const labels = [...container.querySelectorAll('label')].filter(
                (lab) => !lab.querySelector('input[type="radio"], input[type="checkbox"]')
            );
            for (const lab of labels) {
                const t = (lab.innerText || lab.textContent || '').trim();
                if (t.length > 12) return t.split('\n')[0].trim();
            }
            const heading = container.querySelector('h1, h2, h3, h4, p, .label, [class*="label"]');
            if (heading && !heading.querySelector('input')) {
                const t = (heading.innerText || heading.textContent || '').trim();
                if (t.length > 12) return t.split('\n')[0].trim();
            }
        }
        const labelled = first.getAttribute('aria-labelledby')
            || first.closest('[aria-labelledby]')?.getAttribute('aria-labelledby');
        if (labelled) {
            const text = labelled
                .split(/\s+/)
                .map((id) => document.getElementById(id))
                .filter(Boolean)
                .map((n) => (n.innerText || n.textContent || '').trim())
                .filter((t) => t && !/^(less than|5-6|7-10|10\+)/i.test(t))
                .join(' ')
                .trim();
            if (text.length > 12) return text;
        }
        // Walk previous siblings for the question ending in "?"
        let prev = (container || first.parentElement)?.previousElementSibling;
        for (let i = 0; i < 4 && prev; i++, prev = prev.previousElementSibling) {
            const t = (prev.innerText || prev.textContent || '').trim();
            if (t.includes('?') && t.length > 12 && t.length < 400) return t.split('\n')[0].trim();
        }
        return '';
    }

    function isPlaceholderLabelText(text) {
        const t = String(text || '').replace(/\s+/g, ' ').trim();
        if (!t) return true;
        // React-Select / GH: inner input often labelled by the placeholder itself.
        if (/^select(\.\.\.|…|:)?$/i.test(t)) return true;
        if (/^choose(\s+one)?(\.\.\.|…|:)?$/i.test(t)) return true;
        if (/^type to search|^start typing|^search(\.\.\.|…)?$/i.test(t)) return true;
        if (/^type your response(\.\.\.|…|:)?$/i.test(t)) return true;
        if (/^enter (your |a )?response(\.\.\.|…|:)?$/i.test(t)) return true;
        if (/^pick(\s+one)?(\.\.\.|…)?$/i.test(t)) return true;
        if (/^option$/i.test(t)) return true;
        return false;
    }

    function cleanLabelText(text) {
        const t = String(text || '').replace(/\s+/g, ' ').trim().split('\n')[0].trim();
        if (!t || t.length > 500) return '';
        // Strip trailing placeholder noise: "Discipline * Select..."
        const stripped = t
            .replace(/\s+Select(\.\.\.|…|:)?$/i, '')
            .replace(/\s+Choose(\s+one)?(\.\.\.|…|:)?$/i, '')
            .replace(/\s+$/g, '')
            .trim();
        if (isPlaceholderLabelText(stripped)) return '';
        return stripped;
    }

    function labelNearSelectControl(el) {
        // Only look at the immediate field shell — do NOT scan ancestors for other
        // education labels (that wrongly tagged every later select as "Discipline").
        const control = el.closest(
            '.select__control, [class*="select__control"], [class*="select-shell"], '
            + '[class*="selectContainer"], [class*="Select-control"]'
        ) || el;

        // 1) Previous siblings of the control / its parent (GH: <label> then <div.select>)
        const anchors = [control, control.parentElement].filter(Boolean);
        for (const anchor of anchors) {
            let prev = anchor.previousElementSibling;
            for (let i = 0; i < 4 && prev; i++, prev = prev.previousElementSibling) {
                if (prev.matches?.('input, textarea, select, button')) continue;
                if (prev.querySelector?.('input, textarea, select')) {
                    // Likely another field block — stop
                    break;
                }
                const t = cleanLabelText(prev.innerText || prev.textContent || '');
                if (t && t.length >= 2 && t.length < 120) return t;
            }
        }

        // 2) label[for] already handled; also label that wraps only this control's group
        const shell = control.parentElement;
        if (shell) {
            const lab = shell.querySelector(':scope > label, :scope > legend');
            if (lab) {
                const t = cleanLabelText(lab.innerText || lab.textContent || '');
                if (t) return t;
            }
        }
        return '';
    }

    /** Field shells — never match Greenhouse mega-wrapper `.application--questions`. */
    function fieldShell(el) {
        if (!el) return null;
        // Lever cards: always use the full question (label + field), never `.application-field`
        // alone — that class matches `[class*="form-field"]` and loses the real question text.
        const leverQ = el.closest?.(
            'li.application-question, .application-question, .custom-question, [data-qa="additional-card"]'
        );
        if (leverQ) return leverQ;

        const candidates = [];
        let node = el;
        for (let i = 0; i < 8 && node; i++, node = node.parentElement) {
            if (node === document.body || node === document.documentElement) break;
            const cls = String(node.className || '');
            // Mega sections that hold many questions — not a single field shell.
            if (/\bapplication--questions\b|\beducation--container\b|\bapplication--form\b/i.test(cls)) {
                continue;
            }
            // Input-only wrappers (Lever `.application-field`) — keep walking for the label.
            if (/\bapplication-field\b/i.test(cls) && !/\bapplication-question\b/i.test(cls)) {
                continue;
            }
            if (
                node.matches?.(
                    'label, [data-automation-id], .field, .form-field, '
                    + '.job-application-field, .application-question, .ashby-application-form-field-entry, '
                    + '.form-group, .WdG, [data-ui], .input-wrapper, .select-shell, '
                    + '[class*="ApplicationField"]'
                )
            ) {
                candidates.push(node);
            } else if (
                /(?:^|\s)form-field(?:\s|$)/i.test(cls)
                && !/\bapplication-field\b/i.test(cls)
            ) {
                candidates.push(node);
            } else if (/\bquestion\b/i.test(cls) && !/\bquestions\b/i.test(cls)) {
                candidates.push(node);
            }
        }
        // Prefer a shell that still has a visible label / question text.
        for (const c of candidates) {
            const inputs = c.querySelectorAll('input, textarea, select');
            const hasLabel = !!(
                c.querySelector(
                    'label, legend, .application-label, [class*="application-label"], '
                    + 'h4[data-qa="card-name"], [class*="label"]'
                )
            );
            if (inputs.length <= 8 && hasLabel) return c;
            if (inputs.length <= 3) return c;
        }
        return candidates[0] || el.parentElement;
    }

    function labelFor(el) {
        if (el.id) {
            try {
                const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
                if (lab) {
                    const t = cleanLabelText(lab.innerText || lab.textContent || '');
                    if (t) return t;
                }
            } catch (_) { /* ignore */ }
        }
        const aria = el.getAttribute('aria-label');
        if (aria && aria.trim().length > 2) {
            const t = cleanLabelText(aria);
            // Keep searching when aria is just the placeholder ("Select...")
            if (t) return t;
        }
        const labelled = el.getAttribute('aria-labelledby');
        if (labelled) {
            const text = labelled
                .split(/\s+/)
                .map((id) => document.getElementById(id))
                .filter(Boolean)
                .map((node) => (node.innerText || node.textContent || '').trim())
                .filter(Boolean)
                .join(' ')
                .trim();
            const t = cleanLabelText(text);
            if (t) return t;
        }

        const wrap = fieldShell(el);
        if (wrap) {
            // Lever: question text lives in .application-label / card title, not on the input.
            const leverLab = wrap.querySelector?.(
                '.application-label .text, .application-label, h4[data-qa="card-name"], '
                + '[data-qa="card-name"], .card-name'
            );
            if (leverLab && !leverLab.contains(el)) {
                const t = cleanLabelText(leverLab.innerText || leverLab.textContent || '');
                if (t && t.length >= 2 && t.length < 400 && !isPlaceholderLabelText(t)) return t;
            }
            const ownLab = [...wrap.querySelectorAll('label')].find(
                (lab) => lab.htmlFor === el.id
                    || (lab.contains(el) && !lab.querySelector('input[type="radio"], input[type="checkbox"]'))
            );
            if (ownLab) {
                const t = cleanLabelText(ownLab.innerText || ownLab.textContent || '');
                if (t && t.length < 200 && !isPlaceholderLabelText(t)) return t;
            }
            // Only clone small shells — never dump a whole questions section.
            const inputsInWrap = wrap.querySelectorAll('input, textarea, select').length;
            if (inputsInWrap <= 8) {
                try {
                    const clone = wrap.cloneNode(true);
                    clone.querySelectorAll(
                        'input, textarea, select, button, .select__placeholder, [class*="placeholder"], '
                        + '.select__single-value, [class*="single-value"], [class*="menu"], .select__control, '
                        + '[class*="select__control"]'
                    ).forEach((n) => n.remove());
                    const lines = String(clone.innerText || '')
                        .split('\n')
                        .map((s) => cleanLabelText(s))
                        .filter((s) => s && !isPlaceholderLabelText(s));
                    // Prefer a real question line over section headers like "ZIP CODE".
                    const best = lines.find((s) => /\?/.test(s) || s.length >= 18) || lines[0];
                    if (best && best.length < 400) return best;
                } catch (_) { /* ignore */ }
            }
        }

        // Combobox fallback: previous-sibling title only (after wrap failed)
        const isCombo = !!(
            el.getAttribute('role') === 'combobox'
            || el.getAttribute('aria-autocomplete')
            || /select__input|react-select/i.test(String(el.className || ''))
            || el.closest('.select__control, [class*="select__control"]')
        );
        if (isCombo) {
            const near = labelNearSelectControl(el);
            if (near) return near;
        }

        const auto = el.getAttribute('data-automation-id') || '';
        if (auto) {
            const parent = el.closest('[data-automation-id]');
            const legend = parent?.querySelector('label, legend, [data-automation-id$="Label"]');
            if (legend) {
                const t = cleanLabelText(legend.innerText || legend.textContent || '');
                if (t) return t;
            }
            return auto.replace(/([a-z])([A-Z])/g, '$1 $2');
        }
        const prev = el.previousElementSibling;
        if (prev && /label|span|div|p|legend/i.test(prev.tagName)) {
            const t = cleanLabelText(prev.innerText || prev.textContent || '');
            if (t && t.length < 200) return t;
        }
        const ph = cleanLabelText(el.placeholder || '');
        if (ph) return ph;
        return (el.name || el.id || '').trim();
    }

    function findNearbyQuestionText(el) {
        if (!el) return '';
        const shell = fieldShell(el);
        if (!shell) return '';
        // Never scan mega-sections that contain many controls.
        if (shell.querySelectorAll('input, textarea, select').length > 3) return '';
        const texts = [];
        const nodes = [
            ...shell.querySelectorAll('label, legend, p, h1, h2, h3, h4, span, div')
        ];
        for (const n of nodes) {
            if (n.contains(el) && n !== shell) continue;
            if (n.closest('.select__control, [class*="select__menu"], [class*="select__value"]')) continue;
            const t = cleanLabelText(n.innerText || n.textContent || '');
            if (!t || t.length < 12 || t.length > 400) continue;
            if (/^(yes|no|select|other|loading)$/i.test(t)) continue;
            if (/\b(attach|dropbox|accepted file types|enter manually)\b/i.test(t)) continue;
            texts.push(t);
        }
        // Prefer a real question / consent statement over short helpers ("NDA", "Desired salary").
        const scored = texts.map((t) => {
            let score = 0;
            if (/\?/.test(t)) score += 5;
            if (/^(do you|are you|will you|what are|i acknowledge|i consent|i agree)\b/i.test(t)) score += 4;
            if (/\b(sponsor|visa|salary|acknowledg|consent|nda|non[\s_-]*disclosure|note[\s_-]*tak)\b/i.test(t)) {
                score += 3;
            }
            if (t.length > 60) score += 2;
            if (/^(work authorization|desired salary|nda|ai note)/i.test(t)) score -= 3;
            return { t, score };
        }).filter((x) => x.score > 0);
        scored.sort((a, b) => b.score - a.score || b.t.length - a.t.length);
        return scored[0]?.t || '';
    }

    function enrichFieldLabel(el, label) {
        const base = cleanLabelText(label) || String(label || '').trim();
        // Already a clear field label — do not prepend pollution from siblings.
        if (
            base
            && !isPlaceholderLabelText(base)
            && !/^(work authorization|desired salary|nda|ai note)\b/i.test(base)
            && (
                base.length >= 48
                || /\?/.test(base)
                || /^(first|last|email|phone|country|city|state|school|degree|discipline|linkedin|github)\b/i.test(base)
                || /\b(name|email|phone|linkedin|salary|notice|sponsor|consent|acknowledg)\b/i.test(base)
            )
        ) {
            // Still merge nearby ONLY when base is a short helper under a long consent/sponsor question.
            if (!/^(work authorization|desired salary|nda|ai note)\b/i.test(base)) {
                return base;
            }
        }
        const nearby = findNearbyQuestionText(el);
        if (!nearby) return base;
        // Short Greenhouse helpers under the control ("Work Authorization", "NDA") —
        // prepend the real question so classify/sponsorship/consent work.
        if (!base || base.length < 48 || isPlaceholderLabelText(base)
            || /^(work authorization|desired salary|nda|ai note)/i.test(base)) {
            if (nearby.toLowerCase() === base.toLowerCase()) return base;
            return `${nearby} ${base}`.trim();
        }
        // Base already long but missing key sponsorship words that live only nearby
        if (/\b(sponsor|visa)\b/i.test(nearby) && !/\b(sponsor|visa)\b/i.test(base)) {
            return `${nearby} ${base}`.trim();
        }
        return base;
    }

    function fieldKey(el, label) {
        const auto = el.getAttribute('data-automation-id') || '';
        const base = el.id || el.name || auto || '';
        if (base) return String(base).slice(0, 140);
        if (label) return String(label).slice(0, 140);
        // Stable fallback (never Math.random — that breaks collect→fill matching).
        const all = [...document.querySelectorAll('input, textarea, select')];
        const idx = Math.max(0, all.indexOf(el));
        return `${(el.tagName || 'el').toLowerCase()}_${el.type || 'x'}_${idx}`.slice(0, 140);
    }

    function pageHasPhoneTelInput() {
        return !!(
            document.getElementById('phone')
            || document.querySelector('input[type="tel"], input.iti__tel-input')
        );
    }

    function isPhoneDialCountryControl(el) {
        if (!el) return false;
        const tag = String(el.tagName || '').toLowerCase();
        // Native residence <select id="country"> (Workday/kitchen-sink) — never dial code.
        if (tag === 'select') return false;
        // Greenhouse / intl-tel-input: Country* next to Phone is dial code (+1), not residence.
        if (el.closest(
            '.iti, .phone-input, .phone-input__country, .iti__country-container, '
            + '[class*="phone-input"], [class*="PhoneInput"]'
        )) {
            const lab = `${labelFor(el)} ${el.getAttribute('aria-label') || ''} ${el.id || ''}`.toLowerCase();
            if (/\bcountry\b|\bdial\b|\bcalling[\s_-]*code\b|\bphone[\s_-]*code\b/.test(lab)
                || el.id === 'country'
                || el.getAttribute('role') === 'combobox') {
                return true;
            }
        }
        // Gruve/Greenhouse embed: #country dial is combobox / react-select, not a residence <select>.
        if (el.id === 'country' && pageHasPhoneTelInput()) {
            if (
                el.getAttribute('role') === 'combobox'
                || /select__/i.test(String(el.className || ''))
                || el.closest('.select-shell, .select__container, .phone-input, .phone-input__country')
            ) {
                return true;
            }
            return false;
        }
        if (
            el.getAttribute('role') === 'combobox'
            && /select__input/i.test(String(el.className || ''))
            && pageHasPhoneTelInput()
        ) {
            const lab = `${labelFor(el)} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
            if (/^country\*?$/.test(lab.trim()) || /\b(dial|calling)\b.*\bcode\b/.test(lab)) {
                return true;
            }
        }
        return false;
    }

    /** Close intl-tel-input dial list so ArrowDown/Enter cannot pick Afghanistan. */
    function dismissPhoneDialUi() {
        const itiOpen = [...document.querySelectorAll(
            '.iti__country-list, .iti__dropdown-content, .iti--container'
        )].some((m) => {
            try {
                if (m.classList.contains('iti__hide')) return false;
                if (m.getAttribute('aria-hidden') === 'true') return false;
                const st = window.getComputedStyle?.(m);
                if (st && (st.display === 'none' || st.visibility === 'hidden')) return false;
                return m.getClientRects().length > 0;
            } catch (_) {
                return false;
            }
        });
        // Escape only when iti is visibly open — otherwise it closes Greenhouse react-select too.
        if (itiOpen) {
            try {
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true
                }));
            } catch (_) { /* ignore */ }
        }
        try {
            document.querySelectorAll(
                '.iti__dropdown-content, .iti--container, .iti__country-list, .iti__search-container'
            ).forEach((m) => {
                try {
                    m.classList.add('iti__hide');
                    m.style.display = 'none';
                    m.setAttribute('aria-hidden', 'true');
                } catch (_) { /* ignore */ }
            });
            // Never click the flag button — toggle can OPEN the list.
        } catch (_) { /* ignore */ }
        try {
            const dial = document.getElementById('country');
            if (dial && isPhoneDialCountryControl(dial)) {
                try { dial.blur(); } catch (_) { /* ignore */ }
            }
        } catch (_) { /* ignore */ }
    }

    function resolvePhoneInput() {
        return document.getElementById('phone')
            || document.querySelector('input.iti__tel-input[type="tel"], input[type="tel"].iti__tel-input')
            || document.querySelector('input[type="tel"]');
    }

    function dialCountryRoot() {
        return document.querySelector('.phone-input__country')
            || document.getElementById('country')?.closest('.select-shell, .select__container, .phone-input')
            || null;
    }

    function dialCountryIsSet() {
        const root = dialCountryRoot();
        const shell = root?.querySelector?.('.select-shell') || root
            || document.getElementById('country')?.closest('.select-shell, [class*="select-shell"]');
        const sv = (shell?.querySelector?.('.select__single-value')?.textContent || '')
            .replace(/\s+/g, ' ')
            .trim();
        if (/\+1\b/.test(sv) || /^united states/i.test(sv)) return true;
        // Greenhouse shows flag + "+1" inside single-value
        if (shell?.querySelector?.('.iti__flag.iti__us, .iti__us') && /\+1/.test(sv || '+1')) {
            if (shell.querySelector('.select__value-container--has-value')) return true;
        }
        if (shell?.querySelector?.('.select__value-container--has-value') && sv) return true;
        return false;
    }

    function typeIntoDialCountryInput(input, text) {
        if (!input) return;
        // Never type dial-country text into a native residence <select> or non-dial control.
        if (String(input.tagName || '').toLowerCase() === 'select') return;
        if (!isPhoneDialCountryControl(input) && input.getAttribute('role') !== 'combobox') return;
        try { input.focus(); } catch (_) { /* ignore */ }
        try {
            input.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true, cancelable: true
            }));
        } catch (_) { /* ignore */ }
        try {
            if (document.execCommand) {
                document.execCommand('selectAll', false);
                document.execCommand('insertText', false, text);
                return;
            }
        } catch (_) { /* ignore */ }
        try {
            setNativeValue(input, text, { blur: false });
        } catch (_) {
            input.value = text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    function keyOn(el, key, opts = {}) {
        const base = {
            key,
            code: key === 'Enter' ? 'Enter' : key === 'ArrowDown' ? 'ArrowDown' : key,
            keyCode: key === 'Enter' ? 13 : key === 'ArrowDown' ? 40 : 0,
            which: key === 'Enter' ? 13 : key === 'ArrowDown' ? 40 : 0,
            bubbles: true,
            cancelable: true,
            ...opts
        };
        try { el.dispatchEvent(new KeyboardEvent('keydown', base)); } catch (_) { /* ignore */ }
        try { el.dispatchEvent(new KeyboardEvent('keyup', base)); } catch (_) { /* ignore */ }
    }

    /**
     * Set Greenhouse phone dial Country* to United States (+1).
     * Live Gruve: fiber setValue often missing; option nodes exist but are not clickable
     * until filtered. Proven path: open → type "United States" → Enter → shows "+1".
     */
    async function ensureUsDialCode() {
        try {
            if (dialCountryIsSet()) return true;

            const phone = resolvePhoneInput();
            try { phone?.iti?.setCountry?.('us'); } catch (_) { /* ignore */ }

            const country = document.getElementById('country');
            if (!country || !isPhoneDialCountryControl(country)) {
                await delay(80);
                return dialCountryIsSet();
            }

            const control = country.closest('.select__control')
                || dialCountryRoot()?.querySelector?.('.select__control');

            // Keyboard path (reliable on Greenhouse phone-input__country).
            for (let attempt = 1; attempt <= 3; attempt++) {
                if (dialCountryIsSet()) return true;
                try {
                    control?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
                    control?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                    control?.click();
                    await delay(120);
                    typeIntoDialCountryInput(country, 'United States');
                    await delay(280);
                    if (attempt >= 2) {
                        keyOn(country, 'ArrowDown');
                        await delay(80);
                    }
                    keyOn(country, 'Enter');
                    await delay(220);
                    if (dialCountryIsSet()) return true;

                    // Click filtered option if Enter did not commit (no visibility gate —
                    // react-select may keep options in a portal with odd rects).
                    const opt = [...document.querySelectorAll('[role="option"], .select__option')]
                        .find((n) => {
                            const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
                            return /united states/i.test(t) && /\+1/.test(t);
                        });
                    if (opt) {
                        try { opt.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (_) { /* ignore */ }
                        opt.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
                        opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                        opt.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                        opt.click();
                        await delay(180);
                    }
                } catch (_) { /* retry */ }
            }

            // Fiber setValue as last resort when React internals are exposed.
            try {
                const fiberKey = control
                    ? Object.keys(control).find((k) => k.startsWith('__reactFiber$'))
                    : null;
                let fiber = fiberKey ? control[fiberKey] : null;
                let setValue = null;
                let selectOption = null;
                let selectProps = null;
                let options = null;
                for (let i = 0; i < 24 && fiber; i++, fiber = fiber.return) {
                    const p = fiber.memoizedProps || fiber.pendingProps || {};
                    if (typeof p.setValue === 'function') setValue = p.setValue;
                    if (typeof p.selectOption === 'function') selectOption = p.selectOption;
                    if (p.selectProps) selectProps = p.selectProps;
                    if (Array.isArray(p.options) && p.options.length) options = p.options;
                    if ((setValue || selectOption || selectProps?.onChange) && options?.length) break;
                }
                const flat = (list) => (list || []).flatMap((o) => (o?.options ? flat(o.options) : [o]));
                const all = flat(options || selectProps?.options || []);
                const us = all.find((o) => {
                    const lab = String(o?.label || o?.value || '');
                    return /united states/i.test(lab) && /\+1/.test(lab);
                }) || all.find((o) => /united states/i.test(String(o?.label || '')) || o?.value === 'us');
                if (us) {
                    try { setValue?.(us, 'select-option'); } catch (_) { /* ignore */ }
                    try { selectOption?.(us); } catch (_) { /* ignore */ }
                    try {
                        selectProps?.onChange?.(us, { action: 'select-option', option: us });
                    } catch (_) { /* ignore */ }
                    await delay(120);
                }
            } catch (_) { /* ignore */ }

            try { country.blur(); } catch (_) { /* ignore */ }
            dismissPhoneDialUi();
            if (dialCountryIsSet()) return true;

            // Trusted CDP fallback (content-script clicks often cannot open this menu).
            try {
                if (!extensionContextValid()) return dialCountryIsSet();
                const resp = await chrome.runtime.sendMessage({ type: 'ENSURE_US_DIAL_CODE' });
                if (resp?.ok || dialCountryIsSet()) return true;
            } catch (_) { /* ignore */ }

            return dialCountryIsSet();
        } catch (_) {
            return false;
        }
    }

    // Shared with bidderFill.js (separate content-script scope).
    try {
        window.__lumiEnsureUsDialCode = ensureUsDialCode;
        window.__lumiDialCountryIsSet = dialCountryIsSet;
    } catch (_) { /* ignore */ }

    function fillPhoneInput(el, raw) {
        const target = (el && el.type === 'tel') ? el : resolvePhoneInput();
        if (!target || isPhoneDialCountryControl(target)) return false;
        const digits = String(raw || '').replace(/[^\d]/g, '');
        if (!digits) return false;
        let national = digits;
        if (digits.length === 11 && digits.startsWith('1')) national = digits.slice(1);

        // Never leave iti dial open — Enter/ArrowDown from other selects will pick Afghanistan.
        dismissPhoneDialUi();

        try { target.focus(); } catch (_) { /* ignore */ }

        // Best for Greenhouse React+iti: insertText (same path as real typing).
        let ok = false;
        try {
            target.select?.();
            ok = document.execCommand('insertText', false, national);
        } catch (_) { /* ignore */ }

        if (!ok || String(target.value || '').replace(/\D/g, '').length < 7) {
            try {
                const tracker = target._valueTracker;
                if (tracker && typeof tracker.setValue === 'function') tracker.setValue('');
            } catch (_) { /* ignore */ }
            const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
            if (desc?.set) desc.set.call(target, national);
            else target.value = national;
            const propsKey = Object.keys(target).find((k) => k.startsWith('__reactProps$'));
            const props = propsKey ? target[propsKey] : null;
            const evt = { target, currentTarget: target, type: 'input' };
            try { props?.onInput?.(evt); } catch (_) { /* ignore */ }
            try { props?.onChange?.({ ...evt, type: 'change' }); } catch (_) { /* ignore */ }
            try {
                target.dispatchEvent(new InputEvent('input', {
                    bubbles: true, inputType: 'insertText', data: national
                }));
            } catch (_) {
                target.dispatchEvent(new Event('input', { bubbles: true }));
            }
            target.dispatchEvent(new Event('change', { bubbles: true }));
        }

        dismissPhoneDialUi();
        return String(target.value || '').replace(/\D/g, '').length >= 7;
    }

    function classifyPersonal(label, name, autoId = '') {
        const autoExpanded = String(autoId || '')
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/[_-]+/g, ' ');
        const hay = `${label} ${name} ${autoId} ${autoExpanded}`.toLowerCase();
        // Before salary $ — "comfortable interviewing for the salary outlined…?"
        if (isSalaryComfortYesNo(label, name, autoId)) return 'salary_comfort_yes';
        if (SALARY_RE.test(hay)) return 'salary';
        if (/\b(first[\s_-]*name|given[\s_-]*name|fname|legal[\s_-]*first)\b/.test(hay)) return 'first_name';
        if (/\b(last[\s_-]*name|surname|family[\s_-]*name|lname|legal[\s_-]*last)\b/.test(hay)) return 'last_name';
        if (
            /\b(full[\s_-]*name|your[\s_-]*name|applicant[\s_-]*name|candidate[\s_-]*name|legal[\s_-]*name)\b/.test(hay)
            && !/\b(first|last|given|family|sur)\b/.test(hay)
        ) return 'full_name';
        // Single "Name" fields on many ATS forms — but not disability signature Name.
        if (
            /^(name|legal name)$/i.test(String(label || name || '').trim())
            && !/\b(disability|eeo|signature)\b/i.test(hay)
        ) {
            return 'full_name';
        }
        if (
            /\b(disability[\s_-]*signature|disabilitySignature|eeo\[disabilitySignature\])\b/i.test(hay)
            || (/\bdisability\b/.test(hay) && /\bsignature\b/.test(hay) && /\bname\b/.test(hay))
        ) {
            return 'disability_signature';
        }
        if (
            (/\bdisability\b/.test(hay) && /\b(date|today'?s date|signature[\s_-]*date)\b/.test(hay))
            || /\beeo\[disabilityDate\]|disabilityDate\b/i.test(hay)
        ) {
            return 'disability_date';
        }
        if (/\b(e-?mail)\b/.test(hay)) return 'email';
        if (/\b(phone|mobile|tel|cellphone)\b/.test(hay)) return 'phone';
        if (/\blinkedin\b/.test(hay)) return 'linkedin';
        if (/\b(github|public[\s_-]*portfolio)\b/.test(hay)
            || /\burl\b.*\b(github|portfolio)\b|\b(github|portfolio)\b.*\burl\b/.test(hay)) {
            return 'github';
        }
        // Yes/No location/remote BEFORE city/state/country — wording often contains those words.
        if (/\b(working from this state|perform all work from the state|consistently be working|legal entity.{0,40}working)\b/.test(hay)) {
            return 'work_authorization';
        }
        if (
            /\b(able to work remotely|work remotely|remote[\s_-]*work|work from home|free from distractions)\b/.test(hay)
            && !/\b(describe|explain|provide an example|briefly)\b/.test(hay)
        ) {
            return 'work_authorization';
        }
        // Limited state list: "which of the states you currently reside in" / "operates in N states"
        // Must be `state` — not city — so we pick Florida/Texas/… or catch-all.
        if (
            /\bwhich of the states?\b/.test(hay)
            || /\bchoose which(?: of the)? states?\b/.test(hay)
            || /\boperates? in\b.{0,60}\bstates?\b/.test(hay)
            || (/\breside\b/.test(hay) && /\bstates?\b/.test(hay)
                && /\b(choose|select|which|operat|list of)\b/.test(hay))
        ) {
            return 'state';
        }
        // "Where are you located?" — location picker (city or state). Do NOT treat as
        // work_auth just because the help text mentions US residents / hire states.
        if (
            /\bwhere (?:are|do) you (?:located|currently reside|live)\b/.test(hay)
            || /\bwhere are you located\b/.test(hay)
            || /\bcurrent[\s_-]*location\b/.test(hay)
            || /\bwhere do you currently reside\b/.test(hay)
        ) {
            // Long help lists disallowed US states → Greenhouse state <select>
            if (
                /\bstates?\s+we\s+do\s+not\s+hire|\bdo not hire in\b|\bstates? we do not\b/.test(hay)
                || (/\b(alabama|alaska|hawaii|utah|nebraska)\b/.test(hay) && /\bhire\b/.test(hay))
            ) {
                return 'state';
            }
            return 'city';
        }
        // "Do you currently reside in the United States?" is Yes/No auth — not a city field.
        // Exclude "Where do you currently reside?" (city) — that also contains "do you".
        if (
            (/\b(do you|are you)\b/.test(hay) && /\breside\b/.test(hay) && !/\bwhere\b/.test(hay))
            || (/\breside\b/.test(hay) && /\b(united states|u\.?\s*s\.?\s*a?\.?|u\.s\b)\b/.test(hay)
                && !/\bwhere\b/.test(hay))
            || /\blegal(?:ly)?\s+resid|\bpermanent\s+residenc/.test(hay)
        ) {
            return 'work_authorization';
        }
        if (/\b(city|location\s*\(city\)|current[\s_-]*reside|currently reside)\b/.test(hay)
            && !/\blinkedin|url|website|github\b/.test(hay)
            && !/\b(authorized|sponsor|state while employed|working from this state|legal entity|united states)\b/.test(hay)
            && !( /\b(do you|are you)\b/.test(hay) && !/\bwhere\b/.test(hay) )) {
            return 'city';
        }
        // "Authorized to work … without sponsorship?" = work auth Yes — NOT "do you need sponsorship?"
        if (
            /\b(authorized|authorised|eligible)\b/.test(hay)
            && /\bwithout\s+(?:visa\s+)?sponsorship\b/.test(hay)
        ) {
            return 'work_authorization';
        }
        // Sponsorship / work-auth BEFORE country — questions like
        // "require sponsorship … in the country where this job is located"
        // contain "country" but are Yes/No, not a country picker.
        // Also: H-1B / "employment visa status" / "in the future require sponsorship".
        if (
            /\b(sponsor|sponsorship|visa[\s_-]*support|require.*visa|need.*visa|employment[\s_-]*visa|h-?1b|visa[\s_-]*status)\b/.test(hay)
            || /\b(now or in the future).{0,40}\b(sponsor|visa)/.test(hay)
            || /\bwill you.{0,60}\b(require|need).{0,40}\b(sponsor|visa)/.test(hay)
        ) {
            return 'requires_sponsorship';
        }
        // Greenhouse often shows short helper "Work Authorization" under a sponsorship question.
        // Prefer sponsorship when the visible question (or name) mentions visa/sponsor.
        if (
            /\bwork[\s_-]*auth/.test(hay)
            && /\b(sponsor|visa|require)\b/.test(hay)
        ) {
            return 'requires_sponsorship';
        }
        if (
            /\b(work[\s_-]*auth|authoriz(ed|ation)|legally[\s_-]*authorized|eligible[\s_-]*to[\s_-]*work|right[\s_-]*to[\s_-]*work)\b/.test(hay)
            || /\bwhere this job is located\b|\bjob is located\b|\bthis role is located\b/.test(hay)
        ) {
            return 'work_authorization';
        }
        // State/province picker — not "working from this state" / legal-entity Yes/No (handled above).
        if (
            /\b(state|province|region)\b/.test(hay)
            && !/\b(gender|sex|veteran|disab|working from|employed in this role|legal entity|consistently be working)\b/.test(hay)
        ) {
            return 'state';
        }
        // Phone-row "Country" dial-code or residence country (Greenhouse).
        if (/\b(country|nation)\b/.test(hay)
            && !/\b(sponsor|visa|authoriz|authorized|eligible[\s_-]*to[\s_-]*work|where this job is located|job is located|working from this state)\b/.test(hay)) {
            return 'country';
        }
        if (/\b(zip|postal|post[\s_-]*code)\b/.test(hay)) return 'postal_code';
        if (/\b(address|street)\b/.test(hay)) return 'address';
        if (/\b(birth[\s_-]*date|date[\s_-]*of[\s_-]*birth|\bdob\b)\b/.test(hay)) return 'birthdate';
        // Bare "Date" / today's / signature date (not DOB, not start date).
        if (
            (
                /^(date|date\s*\*?)$/.test(hay.trim())
                || /\b(today'?s?\s*date|signature\s*date|date\s*signed|application\s*date|date\s*of\s*application)\b/.test(hay)
            )
            && !/\b(birth|dob|start|available|earliest)\b/.test(hay)
        ) {
            return 'todays_date';
        }
        // Prefer profile when set. These are FIXED answers — never invent via API
        // even if the form wording differs (Gender / Sex / Legal sex, etc.).
        if (/\b(gender|sex)\b/.test(hay) && !/\bsexual\b/.test(hay)) return 'gender';
        if (/\bthink of yourself as\b/.test(hay)) return 'gender';
        if (/\b(disabilit(?:y|ies)|disabled|\bada\b)\b/.test(hay)) return 'disability_status';
        if (/\b(veteran|military[\s_-]*status|armed[\s_-]*forces)\b/.test(hay)) return 'veteran_status';
        if (/\b(race|ethnicity|ethnic)\b/.test(hay) && !/\bhispanic|latino\b/.test(hay)) return 'race_ethnicity';
        if (/\b(hispanic|latino|latina|latinx)\b/.test(hay)) return 'hispanic_latino';
        if (/\b(website|personal[\s_-]*site|homepage|web[\s_-]*site|portfolio)\b/.test(hay)
            && !/\blinkedin\b/.test(hay)
            && !/\bgithub\b/.test(hay)) {
            return 'website_url';
        }
        if (/\b(portfolio|behance|dribbble)\b/.test(hay)) return 'portfolio_url';
        if (/\b(preferred[\s_-]*name|nickname|goes[\s_-]*by)\b/.test(hay)) return 'preferred_name';
        if (/\b(18[\s_-]*or[\s_-]*older|over[\s_-]*18|at[\s_-]*least[\s_-]*18|age[\s_-]*of[\s_-]*majority)\b/.test(hay)) {
            return 'over_18';
        }
        if (/\b(relocat|willing[\s_-]*to[\s_-]*move|open[\s_-]*to[\s_-]*relocat)\w*/.test(hay)) {
            return 'willing_to_relocate';
        }
        if (/\b(travel|willing[\s_-]*to[\s_-]*travel|percent[\s_-]*travel)\b/.test(hay)) {
            return 'willing_to_travel';
        }
        // Education month/year BEFORE generic "start date" (job availability).
        if (
            /start[\s_-]*date[\s_-]*month|start[\s_-]*month|\[start_date\]\s*\[month\]/i.test(hay)
            || (/month/.test(hay) && /start/.test(hay) && !/end/.test(hay)
                && /educat|school|degree|date/.test(hay))
        ) {
            return 'education_start_month';
        }
        if (
            /start[\s_-]*date[\s_-]*year|start[\s_-]*year|\[start_date\]\s*\[year\]/i.test(hay)
            || (/year/.test(hay) && /start/.test(hay) && !/end/.test(hay)
                && /educat|school|degree|date/.test(hay)
                && !/earliest|available|can you start/.test(hay))
        ) {
            return 'education_start_year';
        }
        if (
            /end[\s_-]*date[\s_-]*month|end[\s_-]*month|graduat\w*\s*month|\[end_date\]\s*\[month\]/i.test(hay)
            || (/month/.test(hay) && /end|graduat/.test(hay) && /educat|school|degree|date/.test(hay))
        ) {
            return 'education_end_month';
        }
        if (
            /end[\s_-]*date[\s_-]*year|end[\s_-]*year|graduat\w*\s*year|year\s*of\s*graduation|\[end_date\]\s*\[year\]/i.test(hay)
            || (/year/.test(hay) && /end|graduat/.test(hay) && /educat|school|degree|date/.test(hay))
        ) {
            return 'education_end_year';
        }
        if (/\b(start[\s_-]*date|earliest[\s_-]*start|available[\s_-]*to[\s_-]*start|when[\s_-]*can[\s_-]*you[\s_-]*start)\b/.test(hay)
            && !/\b(month|year|education|school|graduat|degree)\b/.test(hay)) {
            return 'earliest_start_date';
        }
        // Privacy / consent / NDA / AI-recording acknowledge dropdowns (before notice period).
        if (
            /\b(data[\s_-]*protection|privacy[\s_-]*notice|privacy[\s_-]*policy|candidate[\s_-]*privacy|gdpr|ccpa)\b/.test(hay)
            || /\b(data[\s_-]*subject|personal[\s_-]*data[\s_-]*notice)\b/.test(hay)
            || /\b(non[\s_-]*disclosure|\bnda\b)\b/.test(hay)
            || /\b(ai[\s_-]*(powered\s*)?note[\s_-]*tak|note[\s_-]*tak(er|ing)|interview.{0,40}record)\b/.test(hay)
            || (
                /\b(i\s+(acknowledge|consent|agree)|acknowledg(e|ement)|consent\s+to)\b/.test(hay)
                && !/\b(describe|explain|provide|tell us)\b/.test(hay)
            )
        ) {
            return 'data_protection';
        }
        if (/\b(notice[\s_-]*period|notice[\s_-]*time)\b/.test(hay)) return 'notice_period';
        if (/\b(how[\s_-]*did[\s_-]*you[\s_-]*(hear|find)|hear[\s_-]*about|find[\s_-]*this[\s_-]*(position|role|job)|referral[\s_-]*source|source[\s_-]*of[\s_-]*hire)\b/.test(hay)) {
            return 'how_heard';
        }
        // Office hub / hybrid onsite days → Yes
        if (/\bopen to working\b.{0,120}\b(office|hub|onsite|on[\s_-]*site)|\b\d+\s+days?\b.{0,60}\b(office|hub)|office hubs?\b/i.test(hay)) {
            return 'onsite_hub_yes';
        }
        // U.S. person (Yes/No) before export-control citizen list
        if (/\bU\.?\s*S\.?\s*person\b|whether you are a\s*["“']?U\.?\s*S\.?\s*person/i.test(hay)) {
            return 'us_person_yes';
        }
        if (/\b(are you a former\b|former\b.{0,48}\bemployee|employed by\b|ever been employed|have (?:you )?ever been employed|worked\s+(?:before\s+)?(?:at|for|with)\s+(us|this|our|the\s+company|here)|ever\s+worked\s+(?:before\s+)?(?:at|for|with)\s+(us|this|our|here)|previously\s+worked\s+(at|for|here|with\s+(us|this|our)|before)|have you (?:ever )?worked\s+(?:before\s+)?(?:(?:at|for|with)\s+)?(?:this|our|the)\s+(?:company|employer|organization|firm)|(?:related|affiliate|subsidiary|sister|parent|associated)\s+(?:company|companies|employer|entity|role|position)|related\s+(?:company|role|position|employer)|same\s+(?:company|employer)|permanent or temporary employee|(?:currently|previously)\s+(?:\([^)]*\)\s*)?working\s+for|working\s+for\b.{0,80}\b(contractor|contingent)|contractor or contingent|contingent worker|as an?\s+(employee|contractor|contingent)|employee or (?:a )?contractor|internal (?:candidate|employee)|applied (?:here|to (?:us|this)|before))\b/i.test(hay)) {
            return 'previous_employer_no';
        }
        // Stack / tech experience → Yes (not company employment).
        if (/\b((do you have|have you)\b.{0,120}\b(deep\s+)?(hands[\s-]*on\s+)?(experience|worked with|familiar|proficien|knowledge)\b.{0,120}\b(python|java|javascript|typescript|react|sql|aws|azure|gcp|certificate|pki|x\.?509|security|api|rest|kubernetes|docker|devops|ml|ai|production)|experience\b.{0,40}\b(using|with)\b.{0,40}\b(python|java|react|sql|pki|certificate|api))\b/i.test(hay)
            && !/\b(sponsor|visa|disabilit|veteran|felony|describe|tell us|explain|company|employer|affiliate|subsidiary)\b/i.test(hay)) {
            return 'skill_experience';
        }
        if (/\b(relative|family member|know anyone|personal relationship|related to (anyone|an? employee)|friend (working|employed)|anyone you know (who )?(works|is employed))\b/i.test(hay)) {
            return 'employee_relationship_no';
        }
        if (/\b(non[\s_-]*compete|noncompete|restrictive covenant|garden leave)\b/i.test(hay)
            || /\b(incomplete|not complete|unfinished)\b.{0,60}\b(degree|program|education)\b/i.test(hay)) {
            return 'non_compete_no';
        }
        if (/\b(are you|confirm you are)\b.{0,40}\b(a\s+)?(u\.?\s*s\.?\s*|united states)\s*citizen\b/i.test(hay)) {
            return 'us_citizen_yes';
        }
        if (/\b(export[\s_-]*control|EAR\s*\/?\s*ITAR|U\.?\s*S\.?\s*laws concerning the export|confirm I am one of the following)\b/i.test(hay)) {
            return 'export_control_us_citizen';
        }
        if (/\b(immigration\s*status|none of the above.{0,40}immigration)\b/i.test(hay)) {
            return 'immigration_na_if_citizen';
        }
        if (/\b(cuba|iran|north\s*korea|syria|crimea|luhansk|donetsk).{0,40}(reside|residence|permanent)\b|\breside.{0,80}(cuba|iran|north\s*korea|syria)\b/i.test(hay)) {
            return 'sanctioned_countries_no';
        }
        if (/\b(years?[\s_-]*of[\s_-]*experience|total[\s_-]*experience|yoee?\b)\b/.test(hay)
            && !/\byears?[\s_-]*of[\s_-]*experience\s+(with|in|using|on)\b/.test(hay)
            && !/\b(describe|explain|provide|tell us|open[\s_-]*source|example)\b/.test(hay)) {
            return 'years_of_experience';
        }
        // "Which of the following best describes your experience with REST APIs?"
        // AI tools: "select one … best describes you" / knowledge and use with AI tools
        if (/\b(which of the following|best describes|rate your|level of)\b/.test(hay)
            && /\b(experience|proficiency|familiarit|skill|ai tools?|chatgpt|copilot|knowledge and use)\b/.test(hay)) {
            return 'skill_experience';
        }
        if (/\bselect one of the below\b/.test(hay) && /\bbest describes\b/.test(hay)) {
            return 'skill_experience';
        }
        if (/\bexperience with\b/.test(hay) && /\?/.test(hay) && !/\b(describe|tell us|explain)\b/.test(hay)) {
            return 'skill_experience';
        }
        // "Have you written Python … production?" Yes/No skill levels
        if (/\b(have you|do you)\b/.test(hay)
            && /\b(written|built|maintain|used|worked with)\b/.test(hay)
            && /\b(production|python|rest|api|sql|java|react|typescript|golang)\b/.test(hay)
            && /\?/.test(hay)
            && !/\b(describe|tell us|explain|essay)\b/.test(hay)) {
            return 'skill_experience';
        }
        // YoE bucket radios: "How many years … (front end + back end)?"
        if (/\byears?\b/.test(hay) && /\b(experience|exp)\b/.test(hay)
            && !/\b(describe|explain|provide|tell us|open[\s_-]*source|example|with|using)\b/.test(hay)) {
            return 'years_of_experience';
        }
        // Education block fields — fixed from profile (not AI essays).
        if (/\b(school|university|college|institution)\b/.test(hay)
            && !/\b(high[\s_-]*school)\b/.test(hay)
            && !/\b(describe|explain|tell us)\b/.test(hay)) {
            return 'school';
        }
        if (/\b(discipline|major|field[\s_-]*of[\s_-]*study|concentration|area[\s_-]*of[\s_-]*study)\b/.test(hay)) {
            return 'discipline';
        }
        if (/\b(degree)\b/.test(hay)
            && !/\b(highest[\s_-]*(degree|education)|degree[\s_-]*level)\b/.test(hay)
            && !/\b(describe|explain)\b/.test(hay)) {
            return 'degree';
        }
        if (/\b(highest[\s_-]*(degree|education)|education[\s_-]*level|degree[\s_-]*level)\b/.test(hay)) {
            return 'education_level';
        }
        if (/\b(security[\s_-]*clearance|clearance[\s_-]*level)\b/.test(hay)) return 'security_clearance';
        // Cover letter BEFORE resume — "Upload cover letter" must not become resume.
        if (/\b(cover[\s_-]*letter|covering[\s_-]*letter|motivation[\s_-]*letter)\b/.test(hay)) {
            return 'cover_letter';
        }
        // Resume/CV only — do not treat bare "attach/upload file" as resume (hits cover letter slots).
        if (/\b(resume|cv|curriculum[\s_-]*vitae)\b/.test(hay)) return 'resume';
        if (/\b(high[\s_-]*school)\b/.test(hay)
            && /\b(perform|performance|grade|mathematics|math|native language)\b/.test(hay)) {
            return 'high_school_performance';
        }
        if (/\b(rationale|evidence)\b/.test(hay)
            && /\b(high[\s_-]*school|performance|mathematics|native language|selections above)\b/.test(hay)) {
            return 'high_school_rationale';
        }
        if (/\b(bachelor.*degree result|degree result|grading system|expected result if you have not yet graduated)\b/.test(hay)) {
            return 'degree_result';
        }
        if (/\b(how many companies|number of companies|companies have you worked)\b/.test(hay)) {
            return 'employer_count';
        }
        // Nationality menus use the same country list / profile country value.
        if (/\bnationalit/.test(hay)) {
            return 'country';
        }
        return 'question';
    }

    function countEmployersFromProfile(profile) {
        const p = profile || {};
        const blocks = [
            String(p.work_experience || ''),
            String(p.experience || ''),
            String(p.summary || '')
        ].join('\n');
        const byYear = blocks.match(/\b(19|20)\d{2}\b/g);
        if (byYear && byYear.length >= 2) {
            return Math.max(1, Math.min(8, Math.ceil(byYear.length / 2)));
        }
        const atCompany = blocks.match(/\bat\s+[A-Z][A-Za-z0-9&.,'\- ]{2,40}/g);
        return Math.max(1, Math.min(8, atCompany?.length || 1));
    }

    function degreeResultText(profile) {
        const p = profile || {};
        const gpa = String(p.gpa || p.education_gpa || '').trim();
        if (gpa) return gpa.includes('/') ? gpa : `GPA ${gpa}/4.0`;
        const deg = String(p.degree || p.education_level || '').trim();
        if (/bachelor|master|phd/i.test(deg)) return `${deg} completed`;
        return 'no degree';
    }

    function highSchoolRationaleText(profile) {
        const p = profile || {};
        const gpa = String(p.gpa || p.education_gpa || '').trim();
        if (gpa) {
            return `Strong grades in math and language; overall GPA around ${gpa.includes('/') ? gpa : `${gpa}/4.0`}.`;
        }
        return 'Above-average grades in mathematics and native language through high school.';
    }

    const LONE_US_STATE = /^(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia)$/i;

    function sanitizeQuestionAnswer(value, label, profile) {
        let v = String(value || '').trim();
        if (!v) return '';
        const lab = String(label || '').toLowerCase();
        // Never trust AI Yes/No on sponsorship / prior-employer — profile/fixed only.
        if (labelLooksLikeAuthorizedWithoutSponsorship(lab)) {
            return normalizeWorkAuthorization(profile) || 'Yes';
        }
        if (labelLooksLikeSponsorship(lab)) {
            return sponsorshipAnswerFromProfile(profile);
        }
        if (/\b(have you (ever )?worked|previously\s+worked|worked\s+(at|for)\b|former\b.{0,48}\bemployee|are you a former\b|(?:currently|previously).{0,40}working\s+for|contractor or contingent|contingent worker)\b/i.test(lab)) {
            return 'No';
        }
        if (LONE_US_STATE.test(v) && /rationale|evidence|high school|degree result|grading|performance selections/.test(lab)) {
            if (/degree result|bachelor|grading system/.test(lab)) return degreeResultText(profile);
            return highSchoolRationaleText(profile);
        }
        if (/\bhow many companies\b|\bcompanies have you worked\b/.test(lab)) {
            const n = parseInt(v.replace(/[^\d]/g, ''), 10);
            if (!Number.isFinite(n) || n <= 0) return String(countEmployersFromProfile(profile));
        }
        return v;
    }

    function isRequiredField(el, label) {
        if (isLocationSubmitWaived(el, label)) return false;
        if (!el) {
            return /\*/.test(label || '') || /\brequired\b/i.test(label || '');
        }
        if (el.required || el.getAttribute('aria-required') === 'true') return true;
        if (el.closest('[required], .required, .is-required')) return true;
        if (/\*/.test(label || '') || /\brequired\b/i.test(label || '')) return true;
        const lab = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab && (lab.classList.contains('required') || /\*/.test(lab.textContent || ''))) return true;
        return false;
    }

    /** Site says location autocomplete is down — empty Location is allowed for submit. */
    function nearbyFieldContextText(el, label = '') {
        const parts = [String(label || '')];
        if (!el || !el.closest) return parts.join(' ').toLowerCase();
        let node = el;
        for (let depth = 0; depth < 6 && node; depth += 1) {
            try {
                const t = String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
                if (t && t.length < 1200) parts.push(t);
            } catch (_) { /* ignore */ }
            node = node.parentElement;
        }
        return parts.join(' ').toLowerCase();
    }

    function isLocationSubmitWaived(el, label = '') {
        const blob = nearbyFieldContextText(el, label);
        return /location service is temporarily unavailable/.test(blob)
            || /you can submit(?:\s+\w+){0,6}\s+without\s+a\s+location/.test(blob)
            || /submit your application without a location/.test(blob)
            || /without a location\b/.test(blob) && /unavailable|optional|not required|skip/.test(blob);
    }

    /** Site says dropdown miss — type city, state, zip as free text instead. */
    function isLocationManualEntryHint(el, label = '') {
        const blob = nearbyFieldContextText(el, label);
        return /no location found(?:\s+in\s+the\s+dropdown)?/i.test(blob)
            || /add your city[, ]?\s*state[, ]?\s*(and|&)\s*zip/i.test(blob)
            || /enter(?:\s+your)?\s+(?:city|location).{0,40}manually/i.test(blob)
            || /please enter.{0,40}(city|location).{0,40}manually/i.test(blob)
            || /location not (?:found|listed|available)/i.test(blob);
    }

    function formatLocationFreeText(profile, preferred = '') {
        const city = String(profile?.city || preferred || '')
            .split(',')[0]
            .trim();
        const stRaw = String(profile?.state || '').trim();
        const zip = String(profile?.postal_code || profile?.zip || '').trim();
        const st = /^[A-Z]{2}$/i.test(stRaw) ? stRaw.toUpperCase() : stRaw;
        const parts = [];
        if (city) parts.push(city);
        if (st) parts.push(st);
        let out = parts.join(', ');
        if (zip) out = out ? `${out} ${zip}` : zip;
        return out || String(preferred || '').trim();
    }

    function fieldMissingLabel(f) {
        const lab = String(f?.label || '').replace(/\s+/g, ' ').trim();
        if (lab) return lab.slice(0, 120);
        if (f?.kind && f.kind !== 'question') return String(f.kind).replace(/_/g, ' ');
        if (f?.name) return String(f.name).slice(0, 80);
        return String(f?.id || 'required field').slice(0, 80);
    }

    function collectForm() {
        const ats = detectAts();
        if (ats === 'linkedin') {
            return {
                ats,
                blocked: true,
                reason: 'LinkedIn Easy Apply is not supported',
                fields: [],
                questions: [],
                fileInputs: [],
                url: location.href
            };
        }

        const fields = [];
        const questions = [];
        const fileInputs = [];
        const seenIds = new Set();

        const inputs = [...document.querySelectorAll('input, textarea, select')].filter(visible);

        for (const el of inputs) {
            const type = (el.type || el.tagName.toLowerCase()).toLowerCase();
            if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) {
                continue;
            }
            // Intl-tel-input country search + empty react-select decoys — not form answers.
            if (
                type === 'search'
                || /iti__search|iti-.*__search/i.test(el.id || '')
                || /iti__search/i.test(String(el.className || ''))
            ) {
                continue;
            }
            // Phone dial-code Country (+1 flag) — never treat as residence country.
            if (isPhoneDialCountryControl(el)) {
                continue;
            }
            if (
                !el.id && !el.name
                && el.getAttribute('role') !== 'combobox'
                && !/select__input/i.test(String(el.className || ''))
                && type === 'text'
            ) {
                // Greenhouse select-shell decoy inputs without identity.
                if (el.closest('.select-shell, .phone-input__country')) continue;
            }
            // Radio groups handled below as one field per name.
            if (type === 'radio') continue;
            // Skip lone EEO checkboxes; yes/no checkboxes still collected when labeled.
            if (type === 'checkbox') {
                const rawLabel = labelFor(el);
                const label = enrichFieldLabel(el, rawLabel);
                const kind = classifyPersonal(label, el.name || '', el.getAttribute('data-automation-id') || '');
                const hay = `${label} ${el.name || ''} ${el.value || ''}`.toLowerCase();
                const isConsent = /\b(agree|acknowledg|consent|terms|certify|confirm|understand|i understand)\b/.test(hay);
                if (kind === 'question' || kind === 'requires_sponsorship' || kind === 'work_authorization'
                    || kind === 'over_18' || kind === 'willing_to_relocate' || kind === 'data_protection'
                    || isConsent) {
                    const id = fieldKey(el, label);
                    if (seenIds.has(id)) continue;
                    seenIds.add(id);
                    // Consent/terms checkboxes are fixed Yes — not free-text questions.
                    const cbKind = isConsent || kind === 'data_protection' ? 'data_protection' : kind;
                    fields.push({
                        id,
                        label,
                        kind: cbKind,
                        type: 'checkbox',
                        name: el.name || '',
                        autoId: el.getAttribute('data-automation-id') || '',
                        tag: 'input',
                        inputType: 'checkbox',
                        required: isRequiredField(el, label) || isConsent
                    });
                }
                continue;
            }

            const label = enrichFieldLabel(el, labelFor(el));
            const autoId = el.getAttribute('data-automation-id') || '';
            let kind = classifyPersonal(label, el.name || '', autoId);
            // Safety: long Yes/No location questions sometimes still match state/city keywords.
            if (
                (kind === 'state' || kind === 'city')
                && /\b(working from this state|consistently be working|legal entity|able to work remotely|free from distractions)\b/i.test(label)
            ) {
                kind = 'work_authorization';
            }
            // Bare Date + MM/DD/YYYY placeholder → today's date (EST), not birthdate.
            const ph = String(el.placeholder || el.getAttribute('placeholder') || '').toLowerCase();
            if (
                (kind === 'question' || !kind)
                && (
                    /^(date|date\s*\*?)$/i.test(String(label || '').trim())
                    || (/mm\s*\/\s*dd\s*\/\s*yyyy/.test(ph) && !/\b(birth|dob|start|available|earliest)\b/i.test(label || ''))
                )
            ) {
                kind = 'todays_date';
            }
            if (labelLooksLikeAuthorizedWithoutSponsorship(label)) {
                kind = 'work_authorization';
            } else if (labelLooksLikeSponsorship(label)) {
                kind = 'requires_sponsorship';
            }
            const id = fieldKey(el, label);
            if (seenIds.has(id)) continue;
            seenIds.add(id);

            if (type === 'file') {
                let fileKind = kind;
                const idHay = `${el.id || ''} ${el.name || ''}`.toLowerCase();
                const nearby = `${label} ${el.closest(
                    'label, fieldset, .field, .form-field, [class*="upload"], [class*="drop"], [class*="file"]'
                )?.innerText || ''}`;
                if (/cover|letter/i.test(idHay) || /\bcover[\s_-]*letter\b/i.test(label)) {
                    fileKind = 'cover_letter';
                } else if (
                    /resume|cv/i.test(idHay)
                    || /\b(resume|r[ée]sum[eé]|cv|curriculum)\b/i.test(nearby)
                    || (/drop or select/i.test(nearby) && /\.docx?|\.pdf/i.test(nearby))
                ) {
                    fileKind = 'resume';
                }
                // Greenhouse job-boards: id="resume" / id="cover_letter" are authoritative.
                if (/^resume$/i.test(el.id || el.name || '')) fileKind = 'resume';
                if (/^cover_letter$/i.test(el.id || el.name || '')) fileKind = 'cover_letter';
                fileInputs.push({
                    id,
                    label: label || el.id || 'file',
                    kind: fileKind,
                    required: !!(el.required || el.getAttribute('aria-required') === 'true'
                        || /\*/.test(nearby)
                        || /\brequired\b/i.test(label)
                        || fileKind === 'resume')
                });
                continue;
            }

            const isCombobox = !!(
                el.getAttribute('role') === 'combobox'
                || el.getAttribute('aria-autocomplete')
                || el.getAttribute('aria-haspopup') === 'listbox'
                || /select__input|react-select/i.test(el.className || '')
            );

            fields.push({
                id,
                label,
                kind,
                type: type === 'textarea' ? 'textarea' : type,
                name: el.name || '',
                autoId,
                tag: el.tagName.toLowerCase(),
                combobox: isCombobox,
                required: isRequiredField(el, label)
                    || kind === 'requires_sponsorship'
                    || labelLooksLikeSponsorship(label)
            });

            // Send written + eligibility Yes/No / selects to the answers API (profile fills name/email/phone).
            const API_KINDS = new Set([
                'question', 'salary', 'salary_comfort_yes', 'work_authorization', 'requires_sponsorship',
                'previous_employer_no', 'years_of_experience', 'willing_to_relocate',
                'over_18', 'how_heard', 'data_protection', 'employer_count',
                'high_school_performance', 'high_school_rationale', 'degree_result',
                'sanctioned_countries_no', 'export_control_us_citizen', 'immigration_na_if_citizen',
                'onsite_hub_yes', 'us_person_yes'
            ]);
            if (API_KINDS.has(kind)) {
                if (/\b(disabilit(?:y|ies)|gender|sex|veteran|race|ethnicity|hispanic|latino)\b/i.test(label || '')) {
                    continue;
                }
                let options;
                if (el.tagName === 'SELECT') {
                    options = [...el.options]
                        .map((o) => String(o.textContent || o.value || '').trim())
                        .filter((t) => t && !/^select/i.test(t) && t.length < 120)
                        .slice(0, 40);
                } else if (isCombobox) {
                    // React-Select / Pinpoint: options live in fiber, not <option> nodes.
                    options = listReactSelectOptionLabels(el);
                }
                // Yes/No-only menus that mention "salary" are comfort Qs, not $ amounts.
                if (
                    kind === 'salary'
                    && Array.isArray(options)
                    && options.length >= 2
                    && options.every((t) => /^(yes|no)\b/i.test(String(t).trim()))
                ) {
                    kind = 'salary_comfort_yes';
                    fields[fields.length - 1].kind = 'salary_comfort_yes';
                }
                const isChoice = !!(options?.length);
                questions.push({
                    id,
                    label: label || id,
                    type,
                    kind,
                    answer_type: kind === 'salary'
                        ? 'salary'
                        : (isChoice ? 'choice' : 'written'),
                    selected: el.getAttribute('data-bidder-q-selected') === '1',
                    options: options?.length ? options : undefined
                });
            }
        }

        // Hidden dropzone file inputs (Rippling display:none) if the visible() pass missed them.
        for (const el of document.querySelectorAll('input[type="file"]')) {
            if (!el || el.disabled) continue;
            const label = labelFor(el);
            const id = fieldKey(el, label);
            if (seenIds.has(id)) continue;
            const wrap = el.closest(
                'label, fieldset, .field, .form-field, [class*="upload"], [class*="drop"], '
                + '[class*="file"], [class*="attach"]'
            ) || el.parentElement;
            const cr = wrap?.getBoundingClientRect?.();
            const nearby = `${label} ${wrap?.innerText || ''}`;
            const looksDropzone = (cr && cr.width > 4 && cr.height > 4)
                || /\b(resume|r[ée]sum[eé]|cv|curriculum)\b/i.test(nearby)
                || /drop or select/i.test(nearby);
            if (!looksDropzone) continue;
            seenIds.add(id);
            const idHay = `${el.id || ''} ${el.name || ''}`.toLowerCase();
            let fileKind = 'other';
            if (/cover|letter/i.test(idHay) || /\bcover[\s_-]*letter\b/i.test(nearby)) {
                fileKind = 'cover_letter';
            } else if (
                /resume|cv/i.test(idHay)
                || /\b(resume|r[ée]sum[eé]|cv|curriculum)\b/i.test(nearby)
                || (/drop or select/i.test(nearby) && /\.docx?|\.pdf/i.test(nearby))
            ) {
                fileKind = 'resume';
            }
            if (/^resume$/i.test(el.id || el.name || '')) fileKind = 'resume';
            if (/^cover_letter$/i.test(el.id || el.name || '')) fileKind = 'cover_letter';
            fileInputs.push({
                id,
                label: label || el.id || 'file',
                kind: fileKind,
                required: !!(el.required || el.getAttribute('aria-required') === 'true'
                    || /\*/.test(nearby)
                    || fileKind === 'resume')
            });
        }

        // Radio groups: one logical field per name (or shared legend).
        const radios = [...document.querySelectorAll('input[type="radio"]')].filter(visible);
        const byName = new Map();
        for (const el of radios) {
            const key = el.name || `radio_${labelFor(el)}`;
            if (!byName.has(key)) byName.set(key, []);
            byName.get(key).push(el);
        }
        for (const [name, group] of byName) {
            if (!group.length) continue;
            const label = radioGroupQuestionLabel(group)
                || group[0].closest('fieldset')?.querySelector('legend')?.textContent?.trim()
                || name;
            let kind = classifyPersonal(label, name, '');
            // Detect YoE bucket radios by option text even if question label was weak.
            const optText = group.map((r) => labelFor(r) || r.value || '').join(' ').toLowerCase();
            if (
                (kind === 'question' || !kind)
                && /year/i.test(optText)
                && /less than|10\+|5-6|7-10|\d+\s*[-–]\s*\d+\s*years?/i.test(optText)
            ) {
                kind = 'years_of_experience';
            }
            // Force prior-employer / sponsorship even when label enrichment is weak.
            const labLow = String(label || '').toLowerCase();
            if (labelLooksLikeAuthorizedWithoutSponsorship(label)) {
                kind = 'work_authorization';
            } else if (/\b(sponsor|sponsorship|employment[\s_-]*visa|require.*visa|h-?1b|visa[\s_-]*status)\b/.test(labLow)
                || /\bwill you.{0,60}\b(require|need).{0,40}\b(sponsor|visa)\b/.test(labLow)) {
                kind = 'requires_sponsorship';
            } else if (/\b(previously\s+worked|have you (ever )?worked|worked\s+(at|for)|(?:currently|previously).{0,40}working\s+for|contractor or contingent|contingent worker|permanent or temporary employee|former\b.{0,48}\bemployee|are you a former\b)\b/.test(labLow)) {
                kind = 'previous_employer_no';
            }
            const id = `radio_${name}`.slice(0, 140);
            if (seenIds.has(id)) continue;
            seenIds.add(id);
            const options = group.map((r) => {
                const optLabel = radioOptionText(r)
                    || labelFor(r)
                    || r.getAttribute('aria-label')
                    || r.value
                    || '';
                return { value: r.value, label: String(optLabel).trim(), elId: r.id || '' };
            });
            fields.push({
                id,
                label,
                kind,
                type: 'radio',
                name,
                tag: 'input',
                inputType: 'radio',
                options,
                required: group.some((g) => isRequiredField(g, label))
                    || kind === 'requires_sponsorship'
                    || labelLooksLikeSponsorship(label)
            });
            if (
                kind === 'question'
                || kind === 'salary'
                || kind === 'salary_comfort_yes'
                || kind === 'work_authorization'
                || kind === 'requires_sponsorship'
                || kind === 'previous_employer_no'
                || kind === 'years_of_experience'
                || kind === 'willing_to_relocate'
                || kind === 'over_18'
                || kind === 'how_heard'
                || kind === 'data_protection'
                || kind === 'sanctioned_countries_no'
                || kind === 'export_control_us_citizen'
                || kind === 'immigration_na_if_citizen'
                || kind === 'onsite_hub_yes'
                || kind === 'us_person_yes'
            ) {
                if (/\b(disabilit(?:y|ies)|gender|sex|veteran|race|ethnicity|hispanic|latino)\b/i.test(label || '')) {
                    // demographics stay profile-only
                } else {
                    questions.push({
                        id,
                        label: label || id,
                        type: 'radio',
                        kind,
                        answer_type: kind === 'salary' ? 'salary' : 'choice',
                        selected: false,
                        options: options.map((o) => o.label || o.value).filter(Boolean)
                    });
                }
            }
        }

        const selectedQuestions = questions.filter((q) => q.selected);
        const hasExplicitSelection = questions.some((q) => q.selected);

        return {
            ats,
            blocked: false,
            fields,
            questions,
            selectedQuestions: hasExplicitSelection ? selectedQuestions : [],
            hasQuestionSelection: hasExplicitSelection,
            fileInputs,
            url: location.href
        };
    }

    function findFieldElement(fieldId) {
        const inputs = [...document.querySelectorAll('input, textarea, select')].filter(visible);
        for (const el of inputs) {
            const type = (el.type || el.tagName.toLowerCase()).toLowerCase();
            if (['hidden', 'submit', 'button', 'image', 'reset', 'checkbox', 'radio'].includes(type)) {
                continue;
            }
            const label = labelFor(el);
            if (fieldKey(el, label) === fieldId) return el;
        }
        return null;
    }

    function setQuestionSelected(fieldId, on) {
        const el = findFieldElement(fieldId);
        if (!el) return;
        if (on) el.setAttribute('data-bidder-q-selected', '1');
        else el.removeAttribute('data-bidder-q-selected');
        // Visual ring
        el.style.outline = on ? '2px solid #2563eb' : '';
        el.style.outlineOffset = on ? '2px' : '';
    }

    function clearQuestionSelections() {
        document.querySelectorAll('[data-bidder-q-selected]').forEach((el) => {
            el.removeAttribute('data-bidder-q-selected');
            el.style.outline = '';
            el.style.outlineOffset = '';
        });
    }

    function closeQuestionPicker() {
        document.getElementById('__job_apply_bidder_q_picker')?.remove();
    }

    function selectAllQuestions() {
        const form = collectForm();
        if (form.blocked) return { ok: false, error: form.reason };
        const qs = form.questions || [];
        qs.forEach((q) => setQuestionSelected(q.id, true));
        return { ok: true, count: qs.length };
    }

    function showQuestionPicker() {
        const form = collectForm();
        if (form.blocked) {
            showToast(form.reason || 'Site blocked', 'error');
            return { ok: false, error: form.reason };
        }
        const qs = form.questions || [];
        if (!qs.length) {
            showToast('No written/salary questions found on this page', 'error');
            return { ok: false, error: 'no_questions' };
        }

        closeQuestionPicker();
        const panel = document.createElement('div');
        panel.id = '__job_apply_bidder_q_picker';
        Object.assign(panel.style, {
            position: 'fixed',
            zIndex: '2147483647',
            top: '16px',
            right: '16px',
            width: '360px',
            maxHeight: '70vh',
            overflow: 'auto',
            padding: '14px',
            borderRadius: '12px',
            fontFamily: 'system-ui,Segoe UI,sans-serif',
            fontSize: '13px',
            lineHeight: '1.35',
            boxShadow: '0 12px 32px rgba(0,0,0,.35)',
            background: '#0f172a',
            color: '#f8fafc',
            border: '1px solid #334155'
        });

        const selectedIds = new Set(
            qs.filter((q) => q.selected).map((q) => q.id)
        );
        // Default: if nothing selected yet, pre-check all written questions.
        if (selectedIds.size === 0) {
            qs.forEach((q) => selectedIds.add(q.id));
        }

        panel.innerHTML = `
            <div style="font-weight:700;margin-bottom:8px">Select questions to answer</div>
            <div style="opacity:.8;margin-bottom:10px;font-size:12px">
              Check written / salary questions, then click <b>Answer with AI</b>
              (or the floating <b>Answer questions</b> button). Needs a generated CV first.
              <br/><span style="opacity:.75">Alt+Shift+F = profile autofill only (no AI).</span>
            </div>
            <div id="__bidder_q_list"></div>
            <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
              <button type="button" data-act="all" style="flex:1;padding:8px;border-radius:8px;border:0;background:#1d4ed8;color:#fff;cursor:pointer">All</button>
              <button type="button" data-act="none" style="flex:1;padding:8px;border-radius:8px;border:0;background:#334155;color:#fff;cursor:pointer">None</button>
              <button type="button" data-act="answer" style="flex:1.4;padding:8px;border-radius:8px;border:0;background:#15803d;color:#fff;cursor:pointer;font-weight:600">Answer with AI</button>
              <button type="button" data-act="close" style="padding:8px 10px;border-radius:8px;border:0;background:#7f1d1d;color:#fff;cursor:pointer">✕</button>
            </div>
        `;

        const list = panel.querySelector('#__bidder_q_list');
        qs.forEach((q) => {
            const row = document.createElement('label');
            Object.assign(row.style, {
                display: 'flex',
                gap: '8px',
                alignItems: 'flex-start',
                padding: '6px 0',
                borderBottom: '1px solid #1e293b',
                cursor: 'pointer'
            });
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = selectedIds.has(q.id);
            cb.style.marginTop = '2px';
            cb.addEventListener('change', () => {
                setQuestionSelected(q.id, cb.checked);
            });
            const span = document.createElement('span');
            span.textContent = (q.label || q.id).slice(0, 140);
            row.appendChild(cb);
            row.appendChild(span);
            list.appendChild(row);
            setQuestionSelected(q.id, cb.checked);
        });

        panel.addEventListener('click', (e) => {
            const act = e.target?.getAttribute?.('data-act');
            if (!act) return;
            if (act === 'close') {
                closeQuestionPicker();
                return;
            }
            if (act === 'answer') {
                const n = (collectForm().selectedQuestions || []).length;
                closeQuestionPicker();
                if (!n) {
                    showToast('Select at least one question first', 'error');
                    return;
                }
                showToast(`Drafting AI answers for ${n} question(s)…`, 'info');
                safeRuntimeSend({ type: 'RUN_ANSWER_QUESTIONS' }, (res) => {
                    if (!res?.ok) {
                        showToast(res?.error || 'Answer questions failed', 'error');
                        return;
                    }
                    const f = res.result || {};
                    showToast(
                        f.answers
                            ? `Filled ${f.answers} AI answer(s)`
                            : 'Done — check form / Generate tab',
                        'ok'
                    );
                });
                return;
            }
            const checks = [...panel.querySelectorAll('input[type=checkbox]')];
            checks.forEach((cb, i) => {
                cb.checked = act === 'all';
                setQuestionSelected(qs[i].id, act === 'all');
            });
        });

        document.documentElement.appendChild(panel);
        showToast('Select questions, then Answer with AI', 'info');
        return { ok: true, count: qs.length };
    }

    function setNativeValue(el, value, { blur = true } = {}) {
        const str = value == null ? '' : String(value);
        const proto = el.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        // Clear React's value tracker so controlled inputs accept the new value.
        try {
            const tracker = el._valueTracker;
            if (tracker && typeof tracker.setValue === 'function') {
                tracker.setValue(str === '' ? ' ' : '');
            }
        } catch (_) { /* ignore */ }
        if (desc?.set) desc.set.call(el, str);
        else el.value = str;
        try {
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: str }));
        } catch (_) {
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        // Greenhouse Remix/React 19: call fiber onChange when present.
        try {
            const key = Object.keys(el).find((k) => k.startsWith('__reactProps$') || k.startsWith('__reactFiber$'));
            if (key && key.startsWith('__reactProps$')) {
                const props = el[key];
                if (typeof props?.onChange === 'function') {
                    props.onChange({ target: el, currentTarget: el, type: 'change' });
                }
            }
        } catch (_) { /* ignore */ }
        if (blur) {
            try { el.dispatchEvent(new Event('blur', { bubbles: true })); } catch (_) { /* ignore */ }
        }
    }

    function parseEducationParts(profile) {
        if (!profile) return { school: '', degree: '', discipline: '' };
        let school = String(profile.school || '').trim();
        let degree = String(profile.degree || '').trim();
        let discipline = String(profile.discipline || '').trim();

        const firstLine = String(profile.education || '')
            .split(/\n/)
            .map((s) => s.trim())
            .filter(Boolean)[0] || '';

        if (firstLine) {
            // "B.S. in Computer Science at Virginia Tech in 2004 - 2007"
            const m = firstLine.match(/^(.+?)\s+in\s+(.+?)\s+at\s+(.+?)(?:\s+in\s+[\d.]|\s*$)/i);
            if (m) {
                if (!degree) degree = m[1].trim();
                if (!discipline) discipline = m[2].trim();
                if (!school) school = m[3].trim();
            } else {
                const m2 = firstLine.match(/^(.+?)\s+at\s+(.+?)(?:\s+in\s+[\d.]|\s*$)/i);
                if (m2) {
                    if (!degree) degree = m2[1].trim();
                    if (!school) school = m2[2].trim();
                }
            }
        }

        if (!degree && profile.education_level) {
            const level = String(profile.education_level).trim();
            const map = {
                "Bachelor's": 'Bachelor of Science',
                Bachelors: 'Bachelor of Science',
                Bachelor: 'Bachelor of Science',
                "Master's": 'Master of Science',
                Masters: 'Master of Science',
                Master: 'Master of Science',
                Doctorate: 'Doctorate',
                PhD: 'PhD',
                "Associate's": 'Associate of Science',
                'High School': 'High School Diploma'
            };
            degree = map[level] || level;
        }

        // Normalize common short forms for Greenhouse-style menus.
        if (/^b\.?\s*s\.?/i.test(degree) && !/bachelor/i.test(degree)) {
            degree = 'Bachelor of Science';
        }
        if (/^m\.?\s*s\.?/i.test(degree) && !/master/i.test(degree)) {
            degree = 'Master of Science';
        }

        // Pull discipline from free-text education when profile.discipline is blank.
        if (!discipline && firstLine) {
            const dm = firstLine.match(
                /\b(?:in|of)\s+([A-Za-z][A-Za-z0-9 &/+.-]{2,60?}?)(?:\s+at\s+|\s+from\s+|\s+in\s+\d|\s*$)/i
            );
            if (dm) {
                const cand = dm[1].trim();
                if (!/^(science|arts|engineering|studies)$/i.test(cand)) {
                    discipline = cand;
                }
            }
        }
        if (!discipline) {
            const blob = `${profile.education || ''} ${profile.summary || ''} ${profile.headline || ''}`;
            if (/computer\s*science|\bcs\b/i.test(blob)) discipline = 'Computer Science';
            else if (/software\s*engineer/i.test(blob)) discipline = 'Software Engineering';
            else if (/computer\s*engineer/i.test(blob)) discipline = 'Computer Engineering';
            else if (/information\s*technology|\bit\b/i.test(blob)) discipline = 'Information Technology';
            else if (/data\s*science/i.test(blob)) discipline = 'Data Science';
            else if (/electrical\s*engineer/i.test(blob)) discipline = 'Electrical Engineering';
        }

        return { school, degree, discipline };
    }

    const MONTH_NAMES_FILL = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ];

    function parseEducationDates(profile) {
        const p = profile || {};
        const blob = `${p.education || ''} ${p.school || ''} ${p.degree || ''}`;
        const out = {
            startMonth: 'August',
            startYear: '',
            endMonth: 'May',
            endYear: ''
        };
        let m = blob.match(/(\d{1,2})\s*[\/\-]\s*(20\d{2})\s*[-–—to]+\s*(\d{1,2})\s*[\/\-]\s*(20\d{2}|present|current)/i);
        if (m) {
            out.startMonth = MONTH_NAMES_FILL[Math.max(0, Math.min(11, parseInt(m[1], 10) - 1))] || 'August';
            out.startYear = m[2];
            if (!/present|current/i.test(m[4])) {
                out.endMonth = MONTH_NAMES_FILL[Math.max(0, Math.min(11, parseInt(m[3], 10) - 1))] || 'May';
                out.endYear = m[4];
            }
            return out;
        }
        m = blob.match(/\b(19|20)(\d{2})\s*[-–—to]+\s*((?:19|20)\d{2}|present|current)\b/i);
        if (m) {
            out.startYear = `${m[1]}${m[2]}`;
            if (!/present|current/i.test(m[3])) out.endYear = m[3];
            return out;
        }
        m = blob.match(/\b(?:graduat\w*|class of|in)\s+(20\d{2})\b/i) || blob.match(/\b(20\d{2})\b/);
        if (m) {
            const y = parseInt(m[1], 10);
            out.endYear = String(y);
            out.startYear = String(Math.max(1990, y - 4));
        }
        return out;
    }

    function skillExperienceFillAliases(profile, label = '') {
        const n = parseInt(String(profile?.years_of_experience || '').replace(/\D/g, ''), 10) || 0;
        const lab = String(label || '').toLowerCase();
        const isAi = /\b(ai tools?|chatgpt|copilot|generative ai|knowledge and use)\b/.test(lab);
        const isProdYn = /\b(have you|written|runs in a production|production environment)\b/.test(lab)
            || (/\bpython\b/.test(lab) && /\bproduction\b/.test(lab));
        if (isAi) {
            return n >= 3
                ? ['Extensively', 'Yes, extensively', 'Frequently', 'Advanced']
                : ['Occasionally', 'Yes', 'Sometimes'];
        }
        if (isProdYn) {
            return n >= 2
                ? [
                    'Yes – I currently maintain Python services in production',
                    'Yes – I have in the past',
                    'Yes',
                    'Yes, production'
                ]
                : ['No – only academic/personal use', 'No'];
        }
        if (n >= 5) {
            return [
                'Built and maintained APIs and integrated external APIs in production',
                'Built and maintained',
                'production',
                'Expert', 'Advanced', 'Extensive',
                '10+ years', '10 or more', '5+ years', 'Proficient'
            ];
        }
        if (n >= 3) {
            return [
                'Built and maintained', 'production', 'Proficient', 'Intermediate',
                '3-5 years', 'Working knowledge'
            ];
        }
        return ['1-3 years', 'Familiar', 'Beginner', 'Basic', 'Some experience'];
    }

    function yearsExperienceFillValue(profile) {
        const raw = String(profile?.years_of_experience || '').trim();
        const n = parseInt(String(raw).replace(/[^\d]/g, ''), 10);
        // Never answer 0–2 / less than 1 — rewrite to mid/senior band.
        if (!Number.isFinite(n) || n <= 0) return '5+ years';
        if (n >= 10) return '10+ years';
        if (n <= 6 && n >= 5) return '5-6 years';
        if (n <= 10 && n >= 7) return '7-10 years';
        if (n >= 5) return '5+ years';
        if (n >= 3) return '3-5 years';
        return '3-5 years';
    }

    /** Visa sponsorship: always No. */
    function sponsorshipAnswerFromProfile(_profile) {
        return 'No';
    }

    function normalizeWorkAuthorization(_profile) {
        // Hard lock: always authorized Yes.
        return 'Yes';
    }

    function findElByField(field) {
        if (field?.inputType === 'radio' || field?.type === 'radio') {
            const name = field.name;
            if (name) {
                const first = document.querySelector(`input[type="radio"][name="${CSS.escape(name)}"]`);
                if (first) return first;
            }
            return null;
        }
        if (field?.inputType === 'checkbox' || field?.type === 'checkbox') {
            const all = [...document.querySelectorAll('input[type="checkbox"]')];
            return all.find((el) => {
                if (!visible(el)) return false;
                const label = labelFor(el);
                const id = fieldKey(el, label);
                if (id === field.id) return true;
                if (field.name && el.name === field.name) return true;
                return false;
            }) || null;
        }
        const all = [...document.querySelectorAll('input, textarea, select')];
        const wantLabel = String(field.label || '').trim().toLowerCase();
        return all.find((el) => {
            if (!visible(el)) return false;
            const type = (el.type || '').toLowerCase();
            if (type === 'radio' || type === 'checkbox') return false;
            const label = labelFor(el);
            const id = fieldKey(el, label);
            if (id === field.id) return true;
            if (field.autoId && el.getAttribute('data-automation-id') === field.autoId) return true;
            // Prefer exact label match — startsWith causes essay→wrong textarea overwrites.
            if (wantLabel && label.trim().toLowerCase() === wantLabel) return true;
            if (wantLabel && field.kind !== 'question' && label.trim().toLowerCase().startsWith(wantLabel.slice(0, 48))) {
                return true;
            }
            if (field.name && el.name && el.name === field.name) {
                if (!wantLabel) return true;
                if (label.toLowerCase().includes(wantLabel.slice(0, 24))) return true;
            }
            return false;
        }) || null;
    }

    function radioOptionText(r) {
        if (!r) return '';
        const own = r.closest('label');
        if (own && own.querySelector('input[type="radio"]') === r) {
            try {
                const clone = own.cloneNode(true);
                clone.querySelectorAll('input, select, textarea').forEach((n) => n.remove());
                const t = (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
                if (t && t.length < 240) return t;
            } catch (_) { /* ignore */ }
        }
        // Prefer option-only wrappers — never the whole Lever `.application-question`
        // (that concatenates Yes + No and breaks scoreChoice).
        const wrap = r.closest(
            '[class*="answer-alternative"], [class*="application-answer"], '
            + '[class*="radio-option"], [class*="RadioOption"], [role="radio"], '
            + 'li.application-answer, .application-answer'
        ) || r.parentElement;
        if (wrap && !wrap.matches?.('.application-question, fieldset')) {
            try {
                const clone = wrap.cloneNode(true);
                clone.querySelectorAll('input, select, textarea, button').forEach((n) => n.remove());
                const t = (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
                if (t && t.length < 240 && t.length > 0) return t.slice(0, 240);
            } catch (_) { /* ignore */ }
        }
        // Greenhouse / Workday: option text often sits in a sibling span next to the input.
        let sib = r.nextSibling;
        while (sib) {
            const t = String(sib.textContent || '').replace(/\s+/g, ' ').trim();
            if (t) return t.slice(0, 240);
            sib = sib.nextSibling;
        }
        const aria = (r.getAttribute('aria-label') || '').trim();
        if (aria && aria.length < 240) return aria;
        return String(r.value || '').trim();
    }

    function cm() {
        return window.__lumiControlMatch || null;
    }

    function clickRadioMatching(field, value, profileForSponsor = null) {
        let wantRaw = String(value || '').trim();
        // Hard safety: sponsorship radios must never stay on Yes unless profile is exact Yes.
        // Exception: "authorized … without sponsorship?" is work-auth Yes, not sponsorship No.
        if (labelLooksLikeAuthorizedWithoutSponsorship(field?.label)) {
            wantRaw = normalizeWorkAuthorization(
                profileForSponsor || { work_authorization: wantRaw || 'Yes' }
            ) || 'Yes';
        } else if (
            field?.kind === 'disability_status'
            || /\b(disabilit(?:y|ies)|disabled|\bada\b)\b/i.test(String(field?.label || ''))
        ) {
            wantRaw = 'No, I do not have a disability';
        } else if (
            field?.kind === 'requires_sponsorship'
            || labelLooksLikeSponsorship(field?.label)
        ) {
            wantRaw = sponsorshipAnswerFromProfile(
                profileForSponsor || { requires_sponsorship: wantRaw }
            );
        } else if (
            field?.kind === 'previous_employer_no'
            || field?.kind === 'sanctioned_countries_no'
            || /\b(have you (ever )?worked|previously\s+worked|worked\s+(at|for)\b|former\b.{0,48}\bemployee|are you a former\b|(?:currently|previously).{0,40}working\s+for|contractor or contingent|contingent worker|permanent or temporary employee)\b/i.test(String(field?.label || ''))
        ) {
            wantRaw = 'No';
        }
        if (!wantRaw) return false;
        const helper = cm();
        const want = helper?.canonicalizeWant?.(wantRaw) || wantRaw;
        const name = field.name;
        const radios = name
            ? [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`)]
            : [];
        if (!radios.length) return false;

        const score = (r) => {
            const t = radioOptionText(r);
            if (helper) return helper.scoreChoice(want, t, r.value || '');
            const lab = t.toLowerCase().replace(/\s+/g, ' ').trim();
            const w = want.toLowerCase();
            if (lab === w) return 100;
            if (/^(yes|y)$/i.test(w) && /^(yes|y)\b/i.test(lab)) return 90;
            if (/^(no|n)$/i.test(w) && /^(no|n)\b/i.test(lab) && !/^not\b/i.test(lab)) return 90;
            return -1;
        };

        const pickBest = () => {
            let best = null;
            let bestScore = -1;
            let bestLen = 1e9;
            const wantYes = /^(yes|y)\b/i.test(want) || (helper && helper.isAffirmative(want) && !helper.isNegative(want));
            const wantNo = /^(no|n)\b/i.test(want) || (helper && helper.isNegative(want));
            for (const r of radios) {
                let s = score(r);
                const tClean = radioOptionText(r).replace(/\s+/g, ' ').trim();
                if (/^(yes|no)$/i.test(tClean)) {
                    if (wantYes && /^yes$/i.test(tClean)) s = Math.max(s, 100);
                    if (wantNo && /^no$/i.test(tClean)) s = Math.max(s, 100);
                }
                if (wantYes && helper?.hasNegation?.(tClean) && !/^yes\b/i.test(tClean)) {
                    s = -1;
                }
                // Never pick Yes when wanting No (sponsorship / prior-employer).
                if (wantNo && /^(yes)\b/i.test(tClean) && !helper?.hasNegation?.(tClean)) {
                    s = -1;
                }
                const len = tClean.length || 999;
                if (s > bestScore || (s === bestScore && s >= 70 && len < bestLen)) {
                    bestScore = s;
                    bestLen = len;
                    best = r;
                }
            }
            return bestScore >= 65 ? best : null;
        };

        for (let attempt = 0; attempt < 3; attempt++) {
            const best = pickBest();
            if (!best) return false;
            if (helper) helper.clickInputViaLabel(best);
            else {
                const labEl = best.closest('label');
                if (labEl) labEl.click();
                else best.click();
            }
            best.checked = true;
            best.dispatchEvent(new Event('input', { bubbles: true }));
            best.dispatchEvent(new Event('change', { bubbles: true }));
            const checked = document.querySelector(
                `input[type="radio"][name="${CSS.escape(name)}"]:checked`
            );
            if (checked && score(checked) >= 65) return true;
        }
        return false;
    }

    function setCheckbox(el, value) {
        const helper = cm();
        const label = labelFor(el);
        const wantOn = helper
            ? helper.wantCheckboxOn(value, label)
            : /^(yes|y|true|1|agree|accept)/i.test(String(value || '').trim());
        if (el.checked === wantOn) return true;
        if (helper) helper.clickInputViaLabel(el);
        else {
            const labEl = el.closest('label');
            if (labEl) labEl.click();
            else el.click();
        }
        el.checked = wantOn;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return el.checked === wantOn;
    }

    /** Today's date in US Eastern as MM/DD/YYYY (ATS signature / application Date fields). */
    function formatEstTodayMdY() {
        try {
            const parts = new Intl.DateTimeFormat('en-US', {
                timeZone: 'America/New_York',
                month: '2-digit',
                day: '2-digit',
                year: 'numeric'
            }).formatToParts(new Date());
            const get = (t) => parts.find((p) => p.type === t)?.value || '';
            return `${get('month')}/${get('day')}/${get('year')}`;
        } catch (_) {
            const d = new Date();
            const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
            const dd = String(d.getUTCDate()).padStart(2, '0');
            return `${mm}/${dd}/${d.getUTCFullYear()}`;
        }
    }

    /** "Authorized to work without sponsorship?" — answer Yes (work auth), not sponsorship No. */
    function labelLooksLikeAuthorizedWithoutSponsorship(label) {
        const lab = String(label || '').toLowerCase();
        return /\b(authorized|authorised|eligible)\b/.test(lab)
            && /\bwithout\s+(?:visa\s+)?sponsorship\b/.test(lab);
    }

    /** Local essay when AI answers are missing / skipped (time budget). */
    function fallbackEssayForQuestion(label, profile, jobDescription = '') {
        const lab = String(label || '').toLowerCase();
        const p = profile || {};
        const skills = String(p.skills || p.technical_skills || '').trim();
        const yoe = String(p.years_of_experience || '').replace(/\D/g, '') || '';
        if (/\b(aws|amazon web services|glue|lambda|step functions|mwaa|airflow|cloudformation|ecs|eks|s3|dynamodb)\b/i.test(lab)) {
            const skillHint = /\b(aws|lambda|glue|airflow|s3|dynamo|step function)/i.test(skills)
                ? skills.split(/[,;|]/).filter((s) => /aws|lambda|glue|airflow|s3|dynamo|step|cloud/i.test(s)).slice(0, 4).join(', ')
                : 'Lambda, S3, and related data/ETL services';
            return (
                `I have hands-on AWS experience${yoe ? ` across ${yoe}+ years` : ''}, `
                + `most proficient with ${skillHint || 'Lambda, Glue-style ETL, and orchestration'}. `
                + 'I have built and operated serverless and data workflows (ingest → transform → schedule) in production, '
                + 'and I am comfortable extending that work with Step Functions / Airflow-style orchestration where needed.'
            );
        }
        if (/\b(cloud|gcp|azure|kubernetes|k8s|docker|devops|infrastructure)\b/i.test(lab)
            && /\b(experience|proficient|describe|work(?:ed|ing)? with)\b/i.test(lab)) {
            return (
                `I work daily with cloud infrastructure and containerized services${skills ? ` (${skills.split(/[,;|]/).slice(0, 5).join(', ')})` : ''}. `
                + 'I focus on reliable deploys, observability, and keeping production systems maintainable.'
            );
        }
        if (/\b(describe|experience|proficient|tell us|how have you|what (?:is|are) your)\b/i.test(lab)
            && (/\b(python|java|golang|go\b|react|backend|frontend|api|system)\b/i.test(lab) || lab.length > 60)) {
            const roleBits = [p.current_title, p.title, skills.split(/[,;|]/)[0]].filter(Boolean).join(' / ');
            return (
                `I have production experience${yoe ? ` (${yoe}+ years)` : ''}`
                + `${roleBits ? ` in ${roleBits}` : ''} matching this question. `
                + 'I own design through delivery, write clear code, and collaborate closely with product and ops on shipped systems.'
            );
        }
        if (/\b(why|interest|motivat|what draws|excited about)\b/i.test(lab)) {
            return 'This role matches the production work on my resume, and I want to apply that experience on this team.';
        }
        if (jobDescription && /\b(why|company|role|team)\b/i.test(lab)) {
            return 'I am interested in this role because it aligns with the production systems and stack on my resume.';
        }
        return '';
    }

    function labelLooksLikeSponsorship(label) {
        if (labelLooksLikeAuthorizedWithoutSponsorship(label)) return false;
        const lab = String(label || '').toLowerCase();
        return /\b(sponsor|sponsorship|visa[\s_-]*sponsor|visa[\s_-]*support|require.*visa|need.*visa|need\s+visa\s+sponsorship|employment[\s_-]*visa|h-?1b|visa[\s_-]*status)\b/.test(lab)
            || /\b(now or in the future).{0,80}\b(sponsor|visa)/.test(lab)
            || /\bwill you.{0,80}\b(require|need).{0,60}\b(sponsor|visa)/.test(lab)
            || /\bneed\b.{0,40}\bvisa\b.{0,40}\bsponsor/.test(lab);
    }

    function personalValue(kind, profile) {
        if (!profile) return '';
        switch (kind) {
            case 'first_name': return profile.first_name || '';
            case 'last_name': return profile.last_name || '';
            case 'full_name': return `${profile.first_name || ''} ${profile.last_name || ''}`.trim();
            case 'disability_signature': return `${profile.first_name || ''} ${profile.last_name || ''}`.trim();
            case 'disability_date':
            case 'todays_date':
                return formatEstTodayMdY();
            case 'email': return profile.email || '';
            case 'phone': return profile.phone || profile.mobile || profile.telephone || profile.phone_number || '';
            case 'linkedin': return profile.linkedin_url || '';
            case 'github': return profile.github_url || profile.website_url || profile.portfolio_url || '';
            case 'city': {
                const city = profile.city || '';
                const state = profile.state || '';
                const map = {
                    ca: 'California', ny: 'New York', tx: 'Texas', wa: 'Washington',
                    fl: 'Florida', il: 'Illinois', ma: 'Massachusetts', or: 'Oregon',
                    co: 'Colorado', az: 'Arizona', ga: 'Georgia', nc: 'North Carolina',
                    pa: 'Pennsylvania', va: 'Virginia', nj: 'New Jersey', md: 'Maryland',
                    oh: 'Ohio', mi: 'Michigan', mn: 'Minnesota', wi: 'Wisconsin'
                };
                const stateFull = map[String(state).toLowerCase()] || state;
                if (city && state && !/,/.test(city)) {
                    const st = String(state).trim();
                    // Greenhouse "reside" often wants "Palo Alto, CA"
                    if (/^[A-Z]{2}$/i.test(st)) return `${city}, ${st.toUpperCase()}`;
                    return `${city}, ${st}`;
                }
                return city || stateFull || '';
            }
            case 'state': {
                const st = String(profile.state || '').trim();
                const map = {
                    ca: 'California', ny: 'New York', tx: 'Texas', wa: 'Washington',
                    fl: 'Florida', il: 'Illinois', ma: 'Massachusetts', or: 'Oregon',
                    co: 'Colorado', az: 'Arizona', ga: 'Georgia', nc: 'North Carolina',
                    pa: 'Pennsylvania', va: 'Virginia', nj: 'New Jersey', md: 'Maryland',
                    oh: 'Ohio', mi: 'Michigan', mn: 'Minnesota', wi: 'Wisconsin',
                    in: 'Indiana', tn: 'Tennessee', mo: 'Missouri', sc: 'South Carolina',
                    ct: 'Connecticut', nv: 'Nevada', al: 'Alabama', ak: 'Alaska',
                    de: 'Delaware', hi: 'Hawaii', ia: 'Iowa', la: 'Louisiana',
                    ms: 'Mississippi', ne: 'Nebraska', nm: 'New Mexico', ri: 'Rhode Island',
                    sd: 'South Dakota', wv: 'West Virginia', ut: 'Utah', dc: 'District of Columbia'
                };
                return map[st.toLowerCase()] || st;
            }
            case 'country': return profile.country || 'United States';
            case 'postal_code': return profile.postal_code || '';
            case 'address': return profile.address || '';
            case 'birthdate': return profile.birthdate || '';
            case 'todays_date': return formatEstTodayMdY();
            case 'gender': return profile.gender || 'Male';
            case 'work_authorization': return normalizeWorkAuthorization(profile);
            case 'requires_sponsorship': {
                return 'No';
            }
            case 'disability_status':
                // Hard lock: always No for every profile / ATS wording.
                return 'No, I do not have a disability';
            case 'onsite_hub_yes':
            case 'us_person_yes':
            case 'us_citizen_yes':
                return 'Yes';
            case 'veteran_status':
                return profile.veteran_status || 'I am not a protected veteran';
            case 'race_ethnicity': return profile.race_ethnicity || '';
            case 'website_url':
                return profile.website_url || profile.portfolio_url || profile.github_url
                    || profile.linkedin_url || '';
            case 'portfolio_url': return profile.portfolio_url || profile.website_url || profile.github_url || '';
            case 'high_school_performance': return 'Above average';
            case 'high_school_rationale': return highSchoolRationaleText(profile);
            case 'degree_result': return degreeResultText(profile);
            case 'employer_count': return String(countEmployersFromProfile(profile));
            case 'preferred_name': return profile.preferred_name || profile.first_name || '';
            case 'over_18':
                return 'Yes';
            case 'salary_comfort_yes': return 'Yes';
            case 'hispanic_latino': return 'No';
            case 'willing_to_relocate': return profile.willing_to_relocate || 'Yes';
            case 'willing_to_travel': return profile.willing_to_travel || 'Yes';
            case 'earliest_start_date': return profile.earliest_start_date || '2 weeks';
            case 'notice_period': return profile.notice_period || '2 weeks';
            case 'data_protection':
                // Prefer Agree — fill snaps to Yes / I agree / I acknowledge from the open menu.
                return 'I agree';
            case 'how_heard': return profile.how_heard || 'LinkedIn';
            case 'previous_employer_no':
            case 'employee_relationship_no':
            case 'non_compete_no':
            case 'sanctioned_countries_no':
                return 'No';
            case 'export_control_us_citizen': return 'U.S. Citizen';
            case 'immigration_na_if_citizen': return 'N/A';
            case 'years_of_experience': return yearsExperienceFillValue(profile);
            case 'skill_experience': {
                const skillLab = String(field?.label || '');
                if (/\b(former|employed by|related (company|role|employer)|affiliate|subsidiary|this company|our company|worked (at|for) (us|this|our))\b/i.test(skillLab)) {
                    return 'No';
                }
                if (/\b(python|java|react|sql|pki|certificate|aws|api|rest|security|experience (using|with)|worked with|hands[\s-]*on)\b/i.test(skillLab)) {
                    return 'Yes';
                }
                return skillExperienceFillAliases(profile)[0] || 'Yes';
            }
            case 'education_start_month': return parseEducationDates(profile).startMonth || 'August';
            case 'education_start_year': return parseEducationDates(profile).startYear || '';
            case 'education_end_month': return parseEducationDates(profile).endMonth || 'May';
            case 'education_end_year': return parseEducationDates(profile).endYear || '';
            case 'education_level': return profile.education_level || '';
            case 'school': return parseEducationParts(profile).school;
            case 'degree': return parseEducationParts(profile).degree;
            case 'discipline': {
                const d = parseEducationParts(profile).discipline;
                // Never leave required Discipline on "Select..." — CS is the safe tech default.
                return d || 'Computer Science';
            }
            case 'security_clearance': return profile.security_clearance || '';
            default: return '';
        }
    }

    function matchSelectOption(opts, value) {
        const helper = cm();
        if (helper) {
            const hit = helper.matchNativeOption(opts, value, 65);
            if (hit) return hit;
            const canon = helper.canonicalizeWant?.(value);
            if (canon && canon !== value) {
                const hit2 = helper.matchNativeOption(opts, canon, 65);
                if (hit2) return hit2;
            }
        }
        const v = String(value || '').trim().toLowerCase();
        if (!v) return null;
        const scored = opts.map((o) => {
            const t = String(o.text || '').toLowerCase().trim();
            const ov = String(o.value || '').toLowerCase().trim();
            if (!t && !ov) return { o, score: -1 };
            if (helper?.isPlaceholderOption?.(o.text, o.value)) return { o, score: -1 };
            if (ov === v || t === v) return { o, score: 100 };
            // Short answers (No, US, CA) must not substring-match unrelated options.
            if (v.length <= 3) {
                if (t.startsWith(v + ' ') || ov === v) return { o, score: 85 };
                return { o, score: -1 };
            }
            if (t.startsWith(v) || ov.startsWith(v)) return { o, score: 80 };
            if (t.includes(v) || (v.length > 4 && v.includes(t)) || ov.includes(v)) return { o, score: 72 };
            const vTokens = v.split(/\s+/).filter((x) => x.length > 2);
            const hit = vTokens.filter((tok) => t.includes(tok) || ov.includes(tok)).length;
            if (hit && vTokens.length) return { o, score: Math.round((hit / vTokens.length) * 72) };
            return { o, score: -1 };
        }).filter((x) => x.score >= 65);
        scored.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return String(a.o.text || '').length - String(b.o.text || '').length;
        });
        if (scored[0]) return scored[0].o;

        // Yes/No / True/False — word boundary
        if (/^(yes|y|true|1)$/i.test(v)) {
            const match = opts.find((o) => {
                const t = o.text.trim();
                if (/\b(do not|don't|not consent)\b/i.test(t)) return false;
                return /^(yes|y|true|1)\b/i.test(t) || /^(yes|y|true|1)$/i.test(o.value);
            });
            if (match) return match;
        }
        if (/^(no|n|false|0)$/i.test(v)) {
            const match = opts.find((o) => {
                const t = o.text.trim();
                return (/^(no|n|false|0)\b/i.test(t) && !/^not\b/i.test(t) && !/none|not applicable/i.test(t))
                    || /^(no|n|false|0)$/i.test(o.value)
                    || /\b(do not consent|i do not)\b/i.test(t);
            });
            if (match) return match;
        }
        // Gender synonyms (Man↔Male, Woman↔Female)
        const genderMap = {
            man: ['male', 'man', 'm'],
            male: ['male', 'man', 'm'],
            woman: ['female', 'woman', 'f'],
            female: ['female', 'woman', 'f']
        };
        const gKeys = genderMap[v];
        if (gKeys) {
            const match = opts.find((o) => {
                const t = o.text.toLowerCase().trim();
                const ov = o.value.toLowerCase().trim();
                return gKeys.some((k) => t === k || ov === k || t.startsWith(k + ' ') || t.includes(`(${k})`));
            });
            if (match) return match;
        }
        // Acknowledge / consent / data-protection menus
        if (/\b(acknowledg|agree|consent|accept|i have read)\b/i.test(v) || v === 'i acknowledge') {
            const ranked = opts.map((o) => {
                const t = o.text.trim().toLowerCase();
                if (!t || /^select/.test(t)) return { o, score: -1 };
                if (/\b(do not|don't|dont|disagree|decline|refuse|not consent)\b/.test(t)) return { o, score: -1 };
                let score = -1;
                if (/\backnowledg/.test(t)) score = 95;
                else if (/\b(i have read|i agree|i consent|i accept)\b/.test(t)) score = 90;
                else if (/\b(agree|consent|accept)\b/.test(t)) score = 80;
                else if (/^(yes|y)\b/.test(t) && t.length < 20) score = 70;
                return { o, score };
            }).filter((x) => x.score >= 70);
            ranked.sort((a, b) => b.score - a.score);
            if (ranked[0]) return ranked[0].o;
        }
        return null;
    }

    function phoneDigitsMatch(a, b) {
        let da = String(a || '').replace(/[^\d]/g, '');
        let db = String(b || '').replace(/[^\d]/g, '');
        if (da.length === 11 && da.startsWith('1')) da = da.slice(1);
        if (db.length === 11 && db.startsWith('1')) db = db.slice(1);
        if (!da || !db) return false;
        return da === db || da.endsWith(db) || db.endsWith(da);
    }

    function isPlaceholderValue(got) {
        const g = String(got || '').replace(/\s+/g, ' ').trim();
        if (!g) return true;
        if (/^select(\.\.\.|…|:)?$/i.test(g)) return true;
        if (/^choose(\s|$|\.\.\.|…)/i.test(g)) return true;
        if (/^--/.test(g) || /^type to search/i.test(g)) return true;
        return false;
    }

    function effectiveRequiredKind(field) {
        const kind = String(field?.kind || '');
        const lab = String(field?.label || '');
        if (kind === 'previous_employer_no' || kind === 'requires_sponsorship' || kind === 'sanctioned_countries_no') {
            return kind;
        }
        if (/\b(have you (ever )?worked|previously\s+worked|worked\s+(at|for)\b|former\b.{0,48}\bemployee|are you a former\b|(?:currently|previously).{0,40}working\s+for|contractor or contingent|contingent worker)\b/i.test(lab)) {
            return 'previous_employer_no';
        }
        if (labelLooksLikeAuthorizedWithoutSponsorship(lab)) {
            return 'work_authorization';
        }
        if (labelLooksLikeSponsorship(lab)) {
            return 'requires_sponsorship';
        }
        return kind;
    }

    function requiredFieldSatisfied(field, wanted, got) {
        const kind = effectiveRequiredKind(field);
        const el = findElByField(field);
        if (isLocationSubmitWaived(el, field?.label)
            || (/\blocation\b/i.test(String(field?.label || '')) && isLocationSubmitWaived(el, field?.label))) {
            return true;
        }
        // Manual location free-text (Evio-style) counts as complete when non-empty.
        if (
            (kind === 'city' || /\blocation\b/i.test(String(field?.label || '')))
            && String(got || '').trim().length >= 3
            && (isLocationManualEntryHint(el, field?.label)
                || /,\s*[A-Z]{2}\b|\d{5}/i.test(String(got || '')))
        ) {
            return true;
        }
        let w = String(wanted || '').trim();
        if (!w && (kind === 'previous_employer_no' || kind === 'requires_sponsorship' || kind === 'sanctioned_countries_no')) {
            w = 'No';
        }
        if (w && valuesRoughlyMatch(w, got, kind)) return true;
        if (isPlaceholderValue(got)) return false;
        if (kind === 'phone') {
            const d = String(got || '').replace(/[^\d]/g, '');
            return d.length >= 7 || (d.length === 11 && d.startsWith('1'));
        }
        if (kind === 'previous_employer_no' || kind === 'requires_sponsorship' || kind === 'sanctioned_countries_no') {
            return /\bno\b/i.test(got) && !/yes/i.test(String(got).replace(/\bno\b/i, ''));
        }
        if (!w) return true;
        return false;
    }

    function valuesRoughlyMatch(wanted, got, kind = '') {
        const a = String(wanted || '').trim().toLowerCase();
        const b = String(got || '').trim().toLowerCase();
        if (!a) return true;
        if (!b) return false;
        // Lone US state in the box is never "done" when we wanted a real essay.
        if (LONE_US_STATE.test(b) && a.length > 12 && !LONE_US_STATE.test(a)) return false;
        if (a === b) return true;
        if (kind === 'phone' && phoneDigitsMatch(wanted, got)) return true;
        if (kind === 'linkedin' || kind === 'github' || kind === 'website_url' || kind === 'portfolio_url') {
            const normUrl = (s) => String(s || '')
                .toLowerCase()
                .replace(/^https?:\/\//, '')
                .replace(/^www\./, '')
                .replace(/\/+$/, '')
                .replace(/\s+/g, '');
            const wu = normUrl(wanted);
            const gu = normUrl(got);
            if (wu && gu && (wu === gu || gu.includes(wu) || wu.includes(gu))) return true;
        }
        if (kind === 'salary') {
            const digits = (s) => String(s || '').replace(/[^\d]/g, '');
            const ad = digits(wanted);
            const bd = digits(got);
            if (ad && bd && (ad === bd || ad.endsWith(bd) || bd.endsWith(ad))) return true;
            // "$80,000" vs "80000" / "82.5k"
            const an = parseInt(ad, 10);
            const bn = parseInt(bd, 10);
            if (Number.isFinite(an) && Number.isFinite(bn) && an > 1000 && bn > 1000) {
                if (Math.abs(an - bn) / Math.max(an, bn) < 0.15) return true;
            }
        }
        if (a.length > 2 && (b.includes(a) || a.includes(b))) {
            if (/^y/.test(a) && /\bno\b/.test(b) && !/^y/.test(b)) return false;
            // Disability: "do not have a disability" must NOT match Yes via substring.
            if (/disabilit/.test(a + b)) {
                const polYes = (s) => {
                    const x = String(s || '').toLowerCase();
                    if (/do not have|don'?t have|have not had|no disability|not disabled|^no\b/.test(x)) {
                        return false;
                    }
                    return /^yes\b/.test(x) || /have a disability|have had one in the past/.test(x);
                };
                if (polYes(a) !== polYes(b)) return false;
            }
            return true;
        }
        if (/^(yes|y|true|1)$/i.test(a) && /^(yes|y|true|1)\b/i.test(b) && !/\bno\b/.test(b)) return true;
        if (/^(no|n|false|0)$/i.test(a) && (/^(no|n|false|0)\b/i.test(b) || /\bno\b/.test(b))) return true;
        if (kind === 'work_authorization' || kind === 'requires_sponsorship' || kind === 'over_18'
            || kind === 'willing_to_relocate' || kind === 'previous_employer_no' || kind === 'hispanic_latino'
            || kind === 'onsite_hub_yes' || kind === 'us_person_yes'
            || kind === 'salary_comfort_yes') {
            if (/^y/.test(a) && /^y/.test(b) && !/\bno\b/.test(b)) return true;
            if (/^n/.test(a) && (/^n/.test(b) || /\bno\b/.test(b))) return true;
        }
        if (kind === 'years_of_experience') {
            const an = a.match(/(\d+)\s*\+?/);
            const bn = b.match(/(\d+)\s*\+?/);
            if (an && bn && an[1] === bn[1]) return true;
            if (an && b.includes(an[1])) return true;
        }
        if (kind === 'country' && /\+1\b/.test(b) && /united states|usa|\+1|us\b/i.test(a)) return true;
        if (/^select(\.\.\.|…|:)?$/i.test(b) || /^choose/i.test(b)) return false;
        return false;
    }

    function readFieldCurrent(field, el) {
        if (field?.inputType === 'radio' || field?.type === 'radio') {
            const name = field.name || el?.name;
            if (!name) return '';
            const checked = document.querySelector(`input[type="radio"][name="${CSS.escape(name)}"]:checked`);
            if (!checked) return '';
            const lab = checked.closest('label');
            if (lab) {
                const c = lab.cloneNode(true);
                c.querySelectorAll('input').forEach((n) => n.remove());
                return (c.innerText || '').replace(/\s+/g, ' ').trim();
            }
            return radioOptionText(checked) || checked.value || '';
        }
        if (!el) return '';
        if (el.type === 'checkbox') return el.checked ? 'Yes' : 'No';
        if (el.tagName === 'SELECT') {
            return el.options[el.selectedIndex]?.text || el.value || '';
        }
        // React-Select: native input value is often empty after pick — read displayed single-value.
        const root = el.closest(
            '.select-shell, .select__container, .select, [class*="select-shell"], '
            + '.select__control, [class*="select__control"], [class*="Select"]'
        ) || el.parentElement;
        const single = root?.querySelector?.('.select__single-value, [class*="single-value"], [class*="singleValue"]')
            || el.closest('div')?.querySelector?.('.select__single-value, [class*="single-value"]');
        if (single) {
            const t = (single.textContent || '').replace(/\s+/g, ' ').trim();
            if (t && !/^select(\.\.\.|…)?$/i.test(t)) return t;
        }
        if (root?.querySelector?.('.select__value-container--has-value')) {
            const t = (root.querySelector('.select__value-container--has-value')?.textContent || '')
                .replace(/\s+/g, ' ')
                .trim();
            const m = t.match(/^(Yes|No)\b/i);
            if (m) return m[1];
        }
        const multi = root?.querySelectorAll?.('.select__multi-value__label, [class*="multi-value__label"]');
        if (multi && multi.length) {
            return [...multi].map((n) => (n.textContent || '').trim()).filter(Boolean).join(', ');
        }
        return el.value || '';
    }

    async function fillForm({ fields, answers, profile, jobDescription, companyName = '', jobRole = '', skipQuestions = false }) {
        // Close any leftover phone dial-code / select menus from a prior attempt.
        // Must fully dismiss iti (Escape) — display:none alone leaves keydown handlers active.
        // Do NOT set display:none on .select__menu — Greenhouse fixtures / some ATS only
        // toggle the `hidden` attribute, and inline display:none permanently blocks picks.
        try {
            dismissPhoneDialUi();
            document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            document.activeElement?.blur?.();
        } catch (_) { /* ignore */ }

        // Step 1 (always): phone dial Country* → +1 before any other fields.
        try {
            const dialOk = await ensureUsDialCode();
            if (dialOk) {
                updateAutofillPanel({ status: 'Dial country +1 set', progress: 8 });
            }
        } catch (_) { /* continue fill */ }

        const answerById = new Map((answers || []).map((a) => [String(a.id), a.answer]));
        const answerByLabel = new Map(
            (answers || [])
                .filter((a) => a?.label)
                .map((a) => [String(a.label).trim().toLowerCase(), a.answer])
        );
        const lookupAnswer = (field) => {
            const id = String(field?.id || '');
            const label = String(field?.label || '').trim().toLowerCase();
            if (id && answerById.has(id)) return answerById.get(id);
            if (label && answerByLabel.has(label)) return answerByLabel.get(label);
            // Fuzzy: lesson / memory labels often shorten the form question.
            if (label) {
                for (const [k, v] of answerByLabel) {
                    if (!k || !v) continue;
                    if (label.includes(k) || k.includes(label)) return v;
                    const ka = k.replace(/[^a-z0-9]+/g, ' ').trim();
                    const la = label.replace(/[^a-z0-9]+/g, ' ').trim();
                    if (ka && la && (la.includes(ka) || ka.includes(la))) return v;
                }
            }
            return '';
        };
        let filled = 0;
        let skippedSalary = 0;
        let filledSalary = 0;
        let filledWritten = 0;
        let skippedWritten = 0;
        let skippedAlready = 0;
        const pendingCombos = [];
        // Phone last — combobox ArrowDown/Enter must not hit an open iti dial list.
        let deferredPhone = null;

        for (const field of fields || []) {
            const el = findElByField(field);
            if (!el && field.inputType !== 'radio' && field.type !== 'radio') continue;

            let value = '';
            let salaryPick = null;

            if (field.kind === 'salary') {
                // Safety: mis-tagged Yes/No comfort questions must never get a $ amount.
                if (isSalaryComfortYesNo(field.label, field.name || '')) {
                    value = 'Yes';
                } else {
                    value = lookupAnswer(field)
                        || '';
                    salaryPick = pickSalaryExpectation({
                        jobDescription: jobDescription || '',
                        profileSalaryRange: profile?.salary_range || profile?.desired_salary || '',
                        fieldLabel: field.label || '',
                        jobRole: jobRole || '',
                        companyName: companyName || ''
                    });
                    if (!value && salaryPick?.formatted) value = salaryPick.formatted;
                    // Never leave required salary blank — job-inferred or profile fallback.
                    if (!value) {
                        const raw = String(profile?.salary_range || profile?.desired_salary || '').trim();
                        value = raw || salaryPick?.formatted || '$140,000';
                    }
                }
            } else if (field.kind === 'salary_comfort_yes') {
                value = lookupAnswer(field)
                    || 'Yes';
                if (!/^(yes|y)\b/i.test(String(value).trim())) value = 'Yes';
            } else if (field.kind === 'question') {
                const qLabEarly = String(field.label || '');
                // Hard locks first — never take API Yes for sponsorship / prior-employer.
                const forcedKind = classifyPersonal(qLabEarly, field.name || '', '');
                if (forcedKind === 'salary_comfort_yes' || isSalaryComfortYesNo(qLabEarly, field.name || '')) {
                    value = 'Yes';
                } else if (labelLooksLikeAuthorizedWithoutSponsorship(qLabEarly) || forcedKind === 'work_authorization') {
                    value = personalValue('work_authorization', profile) || 'Yes';
                } else if (labelLooksLikeSponsorship(qLabEarly) || forcedKind === 'requires_sponsorship') {
                    value = sponsorshipAnswerFromProfile(profile);
                } else if (forcedKind === 'onsite_hub_yes' || forcedKind === 'us_person_yes'
                    || /\bopen to working\b.{0,120}\b(office|hub|onsite|on[\s_-]*site)|office hubs?\b/i.test(qLabEarly)
                    || /\bU\.?\s*S\.?\s*person\b/i.test(qLabEarly)) {
                    value = 'Yes';
                } else if (forcedKind === 'previous_employer_no' || forcedKind === 'sanctioned_countries_no'
                    || /\b(have you (ever )?worked|previously\s+worked|former\b.{0,48}\bemployee|are you a former\b|employed by\b|ever been employed|have (?:you )?ever been employed|worked\s+(at|for)\b|ever\s+worked\s+(at|for)|(?:currently|previously).{0,40}working\s+for|contractor or contingent|contingent worker|permanent or temporary employee)\b/i.test(qLabEarly)) {
                    value = 'No';
                } else if (forcedKind === 'disability_status'
                    || /\b(disabilit(?:y|ies)|disabled|\bada\b)\b/i.test(qLabEarly)) {
                    // Absolute lock — never take LLM/API Yes for disability.
                    value = 'No, I do not have a disability';
                } else {
                    // Prefer answers API for remaining written questions.
                    value = lookupAnswer(field)
                        || '';
                    if (value) {
                        value = sanitizeQuestionAnswer(value, field.label, profile);
                    }
                    if (!value) {
                        if (forcedKind === 'over_18'
                            || forcedKind === 'city' || forcedKind === 'state' || forcedKind === 'country'
                            || forcedKind === 'todays_date') {
                            value = personalValue(forcedKind, profile)
                                || (forcedKind === 'todays_date' ? formatEstTodayMdY() : '');
                        }
                    }
                }
                // Absolute: any disability-looking question must stay No even if API said Yes.
                if (/\b(disabilit(?:y|ies)|disabled|\bada\b)\b/i.test(qLabEarly)
                    || forcedKind === 'disability_status') {
                    value = 'No, I do not have a disability';
                }
                // Radio/select with known options: snap paraphrased AI text onto an exact choice.
                if (value && Array.isArray(field.options) && field.options.length) {
                    const optLabels = field.options.map((o) => (
                        typeof o === 'string' ? o : (o?.label || o?.value || '')
                    )).filter(Boolean);
                    const helper = cm();
                    let best = null;
                    let bestScore = -1;
                    for (const opt of optLabels) {
                        let s = helper
                            ? helper.scoreChoice(value, opt, '')
                            : (String(opt).toLowerCase() === String(value).toLowerCase() ? 100 : -1);
                        // Never snap Disability want-No onto a Yes option.
                        if (
                            (field.kind === 'disability_status' || /\bdisabilit/i.test(String(field.label || '')))
                            && /^no/i.test(String(value))
                            && /^yes\b/i.test(String(opt))
                        ) {
                            s = -1;
                        }
                        if (s > bestScore) {
                            bestScore = s;
                            best = opt;
                        }
                    }
                    if (best && bestScore >= 55) value = best;
                }
                const qLab = String(field.label || '');
                // Consent / NDA / AI / privacy selects — prefer Agree wording; fill snaps to real menu.
                if (!value && /\b(data[\s_-]*protection|privacy[\s_-]*notice|privacy[\s_-]*policy|non[\s_-]*disclosure|\bnda\b|acknowledg|consent|agree|certify|terms|understand|ai[\s_-]*note|note[\s_-]*tak|interview.{0,40}record|own words|plagiarism)\b/i.test(qLab)) {
                    value = 'I agree';
                }
                const qLow = qLab.toLowerCase();
                if (!value && /rationale|evidence/.test(qLow) && /high school|performance|mathematics|native language/.test(qLow)) {
                    value = personalValue('high_school_rationale', profile);
                }
                if (!value && /bachelor.*degree result|degree result|grading system|expected result/.test(qLow)) {
                    value = personalValue('degree_result', profile);
                }
                // Early profile-only pass: never invent essays/stubs — AI answers overwrite later.
                if (!value && skipQuestions) {
                    skippedWritten += 1;
                    continue;
                }
                if (!value) {
                    value = fallbackEssayForQuestion(field.label, profile, jobDescription || '');
                }
                if (!value && !skipQuestions && (field.inputType === 'textarea' || field.type === 'textarea') && field.required) {
                    const yoe = String(profile?.years_of_experience || '').replace(/\D/g, '');
                    const skills = String(profile?.skills || '').split(/[,;|]/).filter(Boolean).slice(0, 4).join(', ');
                    value = (
                        `I have relevant production experience${yoe ? ` (${yoe}+ years)` : ''}`
                        + `${skills ? ` with ${skills}` : ''} described on my resume, `
                        + 'and I can apply that work directly to this role.'
                    );
                }
                if (!value) {
                    skippedWritten += 1;
                    continue;
                }
            } else {
                // Prefer answers API for eligibility / select kinds; identity stays profile-only.
                // Hard locks: sponsorship / prior-employer / sanctioned NEVER take API Yes.
                const HARD_NO_OR_PROFILE = new Set([
                    'requires_sponsorship', 'previous_employer_no', 'sanctioned_countries_no'
                ]);
                const PROFILE_ONLY = new Set([
                    'first_name', 'last_name', 'full_name', 'email', 'phone',
                    'city', 'state', 'country', 'linkedin', 'github', 'todays_date',
                    'disability_signature', 'disability_date',
                    'disability_status', 'veteran_status', 'race_ethnicity',
                    'hispanic_latino', 'gender', 'birthdate',
                    'requires_sponsorship', 'previous_employer_no', 'sanctioned_countries_no',
                    'work_authorization'
                ]);
                if (field.kind === 'requires_sponsorship' || labelLooksLikeSponsorship(field.label)) {
                    value = sponsorshipAnswerFromProfile(profile);
                } else if (field.kind === 'onsite_hub_yes' || field.kind === 'us_person_yes'
                    || /\bopen to working\b.{0,120}\b(office|hub|onsite|on[\s_-]*site)|office hubs?\b/i.test(String(field.label || ''))
                    || /\bU\.?\s*S\.?\s*person\b/i.test(String(field.label || ''))) {
                    value = 'Yes';
                } else if (field.kind === 'previous_employer_no' || field.kind === 'sanctioned_countries_no'
                    || /\b(have you (ever )?worked|previously\s+worked|former\b.{0,48}\bemployee|are you a former\b|employed by\b|ever been employed|have (?:you )?ever been employed|worked\s+(at|for)\b|ever\s+worked\s+(at|for)|(?:currently|previously).{0,40}working\s+for|contractor or contingent|contingent worker|permanent or temporary employee)\b/i.test(String(field.label || ''))) {
                    value = 'No';
                } else if (field.kind === 'disability_status'
                    || /\b(disabilit(?:y|ies)|disabled|\bada\b)\b/i.test(String(field.label || ''))) {
                    value = 'No, I do not have a disability';
                } else if (field.kind === 'work_authorization' || labelLooksLikeAuthorizedWithoutSponsorship(field.label)) {
                    value = personalValue('work_authorization', profile) || 'Yes';
                } else {
                    const apiVal = lookupAnswer(field)
                        || '';
                    if (apiVal && !PROFILE_ONLY.has(field.kind) && !HARD_NO_OR_PROFILE.has(field.kind)) {
                        value = String(apiVal).trim();
                    } else {
                        value = personalValue(field.kind, profile) || '';
                    }
                }
                // Snap to option list when present
                if (value && Array.isArray(field.options) && field.options.length) {
                    const optLabels = field.options.map((o) => (
                        typeof o === 'string' ? o : (o?.label || o?.value || '')
                    )).filter(Boolean);
                    const helper = cm();
                    let best = null;
                    let bestScore = -1;
                    for (const opt of optLabels) {
                        let s = helper
                            ? helper.scoreChoice(value, opt, '')
                            : (String(opt).toLowerCase() === String(value).toLowerCase() ? 100 : -1);
                        // Never snap Disability want-No onto a Yes option.
                        if (
                            (field.kind === 'disability_status' || /\bdisabilit/i.test(String(field.label || '')))
                            && /^no/i.test(String(value))
                            && /^yes\b/i.test(String(opt))
                        ) {
                            s = -1;
                        }
                        if (s > bestScore) {
                            bestScore = s;
                            best = opt;
                        }
                    }
                    if (best && bestScore >= 55) value = best;
                }
            }
            if (!value) continue;

            // Skip if already filled correctly (stops begin→end→begin overwrite loops).
            // Never soft-skip a wrong Yes on sponsorship / prior-employer.
            const current = readFieldCurrent(field, el);
            const forcedKind = effectiveRequiredKind(field);
            const wrongSponsorYes = (forcedKind === 'requires_sponsorship' || forcedKind === 'previous_employer_no'
                || forcedKind === 'sanctioned_countries_no')
                && /\byes\b/i.test(String(current || ''))
                && /^no$/i.test(String(value || '').trim());
            const wrongDisabilityYes = (
                forcedKind === 'disability_status'
                || /\bdisabilit/i.test(String(field.label || ''))
            )
                && /^yes\b/i.test(String(current || ''))
                && /have a disability|have had/i.test(String(current || ''))
                && !/do not|don'?t|have not had/i.test(String(current || ''));
            if (!wrongSponsorYes && !wrongDisabilityYes && current && valuesRoughlyMatch(value, current, field.kind)) {
                skippedAlready += 1;
                continue;
            }
            // Soft skip: controlMatch score ≥ 70 (long Disability / EEO options).
            try {
                const helper = cm();
                if (
                    !wrongSponsorYes
                    && !wrongDisabilityYes
                    && current
                    && helper
                    && helper.scoreChoice(value, current, '') >= 70
                ) {
                    skippedAlready += 1;
                    continue;
                }
            } catch (_) { /* ignore */ }

            if (field.inputType === 'radio' || field.type === 'radio') {
                if (clickRadioMatching(field, value, profile)) {
                    filled += 1;
                    if (field.kind === 'question') filledWritten += 1;
                    highlightFilledControl(findElByField(field) || el);
                    updateAutofillPanel({
                        status: `Filling… ${filled}`,
                        progress: Math.min(90, 10 + filled * 4),
                        filled
                    });
                } else if (field.kind === 'question') {
                    skippedWritten += 1;
                }
                continue;
            }

            if (field.inputType === 'checkbox' || field.type === 'checkbox') {
                const elCb = findElByField(field);
                let cbValue = value;
                const lab = String(field.label || '').toLowerCase();
                // Consent / agree checkboxes: default ON when we have no explicit No.
                if (/\b(agree|acknowledg|consent|terms|certify)\b/.test(lab)
                    && (!cbValue || /^(yes|y|true|1|agree|accept)$/i.test(String(cbValue).trim()))) {
                    cbValue = 'Yes';
                }
                if (elCb && setCheckbox(elCb, cbValue)) {
                    filled += 1;
                    highlightFilledControl(elCb);
                    updateAutofillPanel({
                        status: `Filling… ${filled}`,
                        progress: Math.min(90, 10 + filled * 4),
                        filled
                    });
                }
                continue;
            }

            // Native <select>: human flow — click open → read options → match → choose.
            if (el.tagName === 'SELECT' || field.type === 'select') {
                let wantSel = value;
                let salaryPickForSelect = salaryPick;
                let selKind = field.kind;
                // Re-classify from label — "Where are you located? (…US residents…)" → state
                const reKind = classifyPersonal(String(field.label || ''), field.name || '', '');
                if (reKind === 'state' || reKind === 'city' || reKind === 'country') {
                    selKind = reKind;
                    wantSel = personalValue(reKind, profile) || wantSel;
                }
                if (selKind === 'salary_comfort_yes' || isSalaryComfortYesNo(field.label, field.name || '')) {
                    selKind = 'salary_comfort_yes';
                    wantSel = 'Yes';
                } else if (field.kind === 'salary' || selKind === 'salary') {
                    salaryPickForSelect = salaryPick || pickSalaryExpectation({
                        jobDescription: jobDescription || '',
                        profileSalaryRange: profile?.salary_range || '',
                        fieldLabel: field.label || '',
                        jobRole: jobRole || '',
                        companyName: companyName || ''
                    });
                    if (salaryPickForSelect?.formatted) wantSel = salaryPickForSelect.formatted;
                    else if (salaryPickForSelect?.value != null) wantSel = String(salaryPickForSelect.value);
                }
                const selEl = el;
                const okSel = await fillNativeSelectHuman(selEl, wantSel, selKind, salaryPickForSelect);
                if (okSel) {
                    filled += 1;
                    if (selKind === 'salary') filledSalary += 1;
                    if (selKind === 'question') filledWritten += 1;
                    highlightFilledControl(selEl);
                    updateAutofillPanel({
                        status: `Filling… ${filled}`,
                        progress: Math.min(90, 10 + filled * 4),
                        filled
                    });
                } else if (selKind === 'salary') {
                    skippedSalary += 1;
                } else if (selKind === 'question') {
                    skippedWritten += 1;
                }
                continue;
            }

            let writeValue = value;
            if (field.kind === 'salary' && (el.type === 'number' || /amount|number/i.test(field.label || ''))) {
                const pick = salaryPick || pickSalaryExpectation({
                    jobDescription: jobDescription || '',
                    profileSalaryRange: profile?.salary_range || '',
                    fieldLabel: field.label || '',
                    jobRole: jobRole || '',
                    companyName: companyName || ''
                });
                if (pick?.value != null) writeValue = String(pick.value);
            }

            // Never dump essays into Yes/No React-Selects (causes "No options").
            if (
                (field.kind === 'work_authorization' || field.kind === 'requires_sponsorship'
                    || field.kind === 'previous_employer_no')
                && String(writeValue).trim().length > 12
            ) {
                if (/^yes\b/i.test(writeValue)) writeValue = 'Yes';
                else if (/^no\b/i.test(writeValue)) writeValue = 'No';
                else writeValue = personalValue(field.kind, profile)
                    || (field.kind === 'previous_employer_no'
                        || field.kind === 'requires_sponsorship'
                        || field.kind === 'sanctioned_countries_no'
                        ? 'No'
                        : 'Yes');
            }

            // Phone BEFORE combobox detection — never treat dial Country / tel as a select.
            if (field.kind === 'phone') {
                deferredPhone = { field, writeValue };
                continue;
            }

            const isComboEl = !!(
                field.combobox
                || el.getAttribute('role') === 'combobox'
                || el.getAttribute('aria-autocomplete')
                || el.getAttribute('aria-haspopup') === 'listbox'
                || /select__input|react-select/i.test(String(el.className || ''))
            );

            // Custom dropdown / combobox: ALWAYS human — open → see items → match → click.
            // Never setNativeValue the answer into a closed select.
            if (isComboEl) {
                if (isPhoneDialCountryControl(el)) continue;
                let short = String(writeValue).trim();
                if (
                    field.kind === 'salary_comfort_yes'
                    || isSalaryComfortYesNo(field.label, field.name || '')
                ) {
                    writeValue = 'Yes';
                    short = 'Yes';
                }
                if (field.kind === 'question' && short.length > 80) {
                    skippedWritten += 1;
                    continue;
                }
                const kind = (
                    field.kind === 'salary_comfort_yes'
                    || isSalaryComfortYesNo(field.label, field.name || '')
                ) ? 'salary_comfort_yes' : (field.kind || '');
                const comboEl = el;
                let comboPromise;
                if (kind === 'city' || kind === 'state' || kind === 'country'
                    || kind === 'school' || kind === 'degree' || kind === 'discipline'
                    || kind === 'education_level' || kind === 'high_school_performance'
                    || kind === 'skill_experience' || kind === 'years_of_experience'
                    || /^education_(start|end)_/.test(kind)) {
                    comboPromise = scheduleLocationAutocomplete(comboEl, writeValue, kind || 'city', profile);
                } else {
                    const aliases = [];
                    if (kind === 'data_protection' || kind === 'question'
                        || /agree|acknowledg|consent|plagiarism|own words/i.test(String(field.label || ''))) {
                        aliases.push(
                            'Yes', 'I acknowledge', 'I agree', 'I consent',
                            'Acknowledge', 'Agree', 'Consent', 'I understand'
                        );
                    }
                    if (kind === 'requires_sponsorship') {
                        aliases.push('No', 'No, I do not', 'I do not require sponsorship');
                    }
                    if (kind === 'employer_count') {
                        aliases.push(String(writeValue), '1', '2', '3', '4', '5+');
                    }
                    if (kind === 'salary_comfort_yes') {
                        aliases.push('Yes', 'Y', 'True');
                    }
                    comboPromise = scheduleHumanCombobox(comboEl, writeValue, {
                        kind: kind === 'salary_comfort_yes'
                            ? 'yesno'
                            : kind
                            || (/^(yes|no|i agree)$/i.test(short) ? 'yesno' : '')
                            || (/agree|acknowledg|consent|plagiarism|own words/i.test(String(field.label || ''))
                                ? 'data_protection'
                                : ''),
                        minScore: 65,
                        aliases
                    });
                }
                pendingCombos.push(Promise.resolve(comboPromise).then((ok) => {                    if (!ok) {
                        if (kind === 'question') skippedWritten += 1;
                        else if (kind === 'salary') skippedSalary += 1;
                        return;
                    }
                    filled += 1;
                    if (kind === 'salary') filledSalary += 1;
                    if (kind === 'question') filledWritten += 1;
                    highlightFilledControl(comboEl);
                    updateAutofillPanel({
                        status: `Filling… ${filled}`,
                        progress: Math.min(90, 10 + filled * 4),
                        filled
                    });
                }));
                continue;
            }

            setNativeValue(el, writeValue, { blur: true });
            filled += 1;
            if (field.kind === 'salary') filledSalary += 1;
            if (field.kind === 'question') filledWritten += 1;
            highlightFilledControl(el);
            updateAutofillPanel({
                status: `Filling… ${filled}`,
                progress: Math.min(90, 10 + filled * 4),
                filled
            });
        }

        await Promise.all(pendingCombos);
        await waitComboboxIdle(45000);

        // Absolute final pass: Disability must be No (API/question path used to leave Yes).
        try {
            for (const field of fields || []) {
                const lab = String(field.label || '');
                const isDis = field.kind === 'disability_status'
                    || /\b(disabilit(?:y|ies)|disabled|\bada\b)\b/i.test(lab);
                if (!isDis) continue;
                const el = findElByField(field);
                const current = readFieldCurrent(field, el);
                const wrongYes = /^yes\b/i.test(String(current || ''))
                    && /disabilit|have had|disabled/i.test(String(current || ''))
                    && !/do not|don'?t|have not had|no disability|not disabled/i.test(String(current || ''));
                const empty = !current || /^select(\.\.\.|…|:)?$/i.test(String(current).trim());
                if (!wrongYes && !empty) continue;
                const wantNo = 'No, I do not have a disability';
                if (field.inputType === 'radio' || field.type === 'radio') {
                    clickRadioMatching({ ...field, kind: 'disability_status' }, wantNo, profile);
                } else if (el) {
                    await fillComboboxSimplify(el, wantNo, {
                        kind: 'disability_status',
                        aliases: [
                            wantNo,
                            "No, I don't have a disability, and have not had one in the past",
                            'No',
                            'I do not have a disability'
                        ],
                        maxAttempts: 4,
                        minScore: 55
                    });
                }
            }
        } catch (disErr) {
            console.warn('[fill] disability final pass', disErr?.message || disErr);
        }

        if (deferredPhone) {
            dismissPhoneDialUi();
            // Required Country* next to Phone is dial code — set +1 before typing digits.
            await ensureUsDialCode();
            let phoneVal = String(deferredPhone.writeValue || '').trim();
            if (!phoneVal) {
                phoneVal = String(
                    profile?.phone || profile?.mobile || profile?.telephone || profile?.phone_number || ''
                ).trim();
            }
            const phoneEl = resolvePhoneInput()
                || findElByField(deferredPhone.field);
            let ok = fillPhoneInput(phoneEl, phoneVal);
            if (!ok) {
                // Last resort after selects settle.
                dismissPhoneDialUi();
                await ensureUsDialCode();
                ok = fillPhoneInput(resolvePhoneInput(), phoneVal);
            }
            // Greenhouse sometimes needs a second type after dial-code settle.
            if (!ok || String(resolvePhoneInput()?.value || '').replace(/\D/g, '').length < 7) {
                await new Promise((r) => setTimeout(r, 350));
                dismissPhoneDialUi();
                await ensureUsDialCode();
                ok = fillPhoneInput(resolvePhoneInput(), phoneVal) || ok;
            }
            if (ok || String(resolvePhoneInput()?.value || '').replace(/\D/g, '').length >= 7) {
                filled += 1;
                highlightFilledControl(resolvePhoneInput() || phoneEl);
            }
            if (!dialCountryIsSet()) {
                await ensureUsDialCode();
            }
            dismissPhoneDialUi();
            if (dialCountryIsSet()) {
                const dialEl = document.getElementById('country');
                if (dialEl) highlightFilledControl(dialEl);
            }
            updateAutofillPanel({
                status: `Filling… ${filled}`,
                progress: Math.min(90, 10 + filled * 4),
                filled
            });
        }

        dismissPhoneDialUi();
        updateAutofillPanel({
            status: filled ? `Filled ${filled} — review before submit` : 'No fields filled',
            progress: filled ? 100 : 0,
            filled
        });

        // Required-field truth (Lever/Ashby/Workday/etc.) — same gate as bidderFill.
        const requiredFields = (fields || []).filter((f) => f.required);
        let requiredOk = 0;
        const missingRequired = [];
        for (const f of requiredFields) {
            const el = findElByField(f);
            let wanted = '';
            if (f.kind === 'salary') {
                if (isSalaryComfortYesNo(f.label, f.name || '')) {
                    wanted = 'Yes';
                } else {
                    wanted = lookupAnswer(f)
                        || '';
                    if (!wanted) {
                        const salaryPick = pickSalaryExpectation({
                            jobDescription: jobDescription || '',
                            profileSalaryRange: profile?.salary_range || profile?.desired_salary || '',
                            fieldLabel: f.label || '',
                            jobRole: jobRole || '',
                            companyName: companyName || ''
                        });
                        wanted = salaryPick?.formatted
                            || String(profile?.salary_range || profile?.desired_salary || '').trim()
                            || '$140,000';
                    }
                }
            } else if (f.kind === 'salary_comfort_yes') {
                wanted = 'Yes';
            } else if (f.kind === 'question') {
                wanted = lookupAnswer(f)
                    || '';
                wanted = sanitizeQuestionAnswer(wanted, f.label, profile);
                if (isSalaryComfortYesNo(f.label, f.name || '')) wanted = 'Yes';
            } else {
                // Fixed kinds: profile only — never let AI Yes override sponsorship / prior employer.
                wanted = personalValue(f.kind, profile)
                    || (f.kind === 'previous_employer_no'
                        || f.kind === 'requires_sponsorship'
                        || f.kind === 'sanctioned_countries_no'
                        ? 'No'
                        : '');
            }
            const got = readFieldCurrent(f, el);
            if (requiredFieldSatisfied(f, wanted, got)) {
                requiredOk += 1;
            } else {
                missingRequired.push(fieldMissingLabel(f));
            }
        }
        const requiredTotal = requiredFields.length;
        const requiredComplete = requiredTotal === 0
            ? filled > 0
            : requiredOk === requiredTotal;

        return {
            filled,
            skippedSalary,
            filledSalary,
            filledWritten,
            skippedWritten,
            skippedAlready,
            requiredComplete,
            requiredOk,
            requiredTotal,
            missingRequired,
            incomplete: !requiredComplete
        };
    }

    /** Serialize React-Select fills — parallel timeouts race and leave Country/School empty. */
    const comboboxJobs = [];
    let comboboxBusy = false;

    function enqueueCombobox(job) {
        comboboxJobs.push(job);
        pumpComboboxQueue();
    }

    function waitComboboxIdle(timeoutMs = 45000) {
        return new Promise((resolve) => {
            const start = Date.now();
            const tick = () => {
                if (!comboboxBusy && comboboxJobs.length === 0) {
                    resolve(true);
                    return;
                }
                if (Date.now() - start > timeoutMs) {
                    resolve(false);
                    return;
                }
                setTimeout(tick, 80);
            };
            // Let the current macrotask enqueue jobs first.
            setTimeout(tick, 0);
        });
    }

    function pumpComboboxQueue() {
        if (comboboxBusy) return;
        const next = comboboxJobs.shift();
        if (!next) return;
        comboboxBusy = true;
        Promise.resolve()
            .then(() => next())
            .catch(() => false)
            .then((ok) => {
                // Fast-path between selects when the last one already completed.
                // Keep a short gap only when it failed (menu may still be closing).
                const gap = ok ? 40 : 160;
                return new Promise((r) => setTimeout(r, gap));
            })
            .finally(() => {
                comboboxBusy = false;
                pumpComboboxQueue();
            });
    }

    function openReactSelect(el, { clear = false } = {}) {
        if (!el) return;
        if (isPhoneDialCountryControl(el)) return;
        // Always dismiss phone dial-code UI first — it steals Enter/ArrowDown on Greenhouse.
        dismissPhoneDialUi();
        
        const shell = el.closest('.select-shell, [class*="select-shell"]');
        const control = el.closest('.select__control, [class*="select__control"], [class*="Select-control"]')
            || shell
            || el.parentElement;
        // Only clear when explicitly resetting a failed attempt — never wipe a completed value.
        if (clear) {
            try {
                const clearBtn = control?.querySelector(
                    '.select__clear-indicator, [class*="clear-indicator"], [aria-label="Clear"]'
                );
                if (clearBtn) clearBtn.click();
            } catch (_) { /* ignore */ }
        }
        try {
            const indicator = control?.querySelector(
                '.select__dropdown-indicator, [class*="dropdown-indicator"], [class*="DropdownIndicator"]'
            );
            if (indicator) {
                indicator.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
                indicator.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                indicator.click();
            }
            if (control) {
                control.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
                control.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                control.click();
            }
            if (shell && shell !== control) {
                shell.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
                shell.click();
            }
            // Undo any leftover inline display:none on this field's menu.
            try {
                const fieldRoot = el.closest('.field, .form-field, .select-shell, [class*="question"]') || el.parentElement;
                fieldRoot?.querySelectorAll?.('.select__menu, [class*="select__menu"]').forEach((m) => {
                    if (m.style?.display === 'none') m.style.display = '';
                });
            } catch (_) { /* ignore */ }
            el.focus();
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            el.click();
        } catch (_) { /* ignore */ }
    }

    function delay(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    /** Poll until predicate is true; return immediately when complete (no extra wait). */
    async function waitUntil(predicate, { timeoutMs = 1500, pollMs = 50 } = {}) {
        const start = Date.now();
        if (predicate()) return true;
        while (Date.now() - start < timeoutMs) {
            await delay(pollMs);
            if (predicate()) return true;
        }
        return !!predicate();
    }

    function listOpenSelectOptions(anchorEl = null) {
        const listId = anchorEl?.getAttribute?.('aria-controls') || '';
        const ownedMenu = listId ? document.getElementById(listId) : null;
        const shell = anchorEl?.closest?.(
            '.select-shell, [class*="select-shell"], .select__control, [class*="select__control"]'
        );
        return [
            ...document.querySelectorAll(
                '[role="option"], .select__option, [id*="option-"], [class*="menu"] [class*="option"], [class*="listbox"] [class*="option"], .pac-item, li[role="option"]'
            )
        ].filter((n) => {
            // Never pick from phone dial-code country lists (+1 / Afghanistan…).
            if (n.closest(
                '.iti, .iti__dropdown-content, .iti--container, .phone-input, '
                + '.phone-input__country, [class*="phone-input"]'
            )) {
                return false;
            }
            if (n.closest('[hidden], [aria-hidden="true"]')) return false;
            const st = window.getComputedStyle?.(n);
            if (st && (st.display === 'none' || st.visibility === 'hidden')) return false;
            if (n.getClientRects().length === 0 && n.offsetParent === null) return false;
            const t = String(n.textContent || '').replace(/\s+/g, ' ').trim();
            if (!t || /^no options$/i.test(t) || /^no results/i.test(t) || /^loading/i.test(t)) return false;
            if (/^type to search|^start typing|^search\.\.\./i.test(t)) return false;
            // Dial-code rows: "United States +1" / "Afghanistan+93" / "+93"
            if (/^\+\d{1,4}$/.test(t)) return false;
            if (/^[A-Za-zÀ-ÿ].*\+\d{1,4}\s*$/.test(t)) return false;
            if (/\+\d{1,4}\s*$/.test(t) && /\b(flag|afghanistan|albania|algeria|american samoa|andorra|angola|anguilla|united states)\b/i.test(t)) {
                return false;
            }
            if (!anchorEl) return true;
            if (ownedMenu && ownedMenu.contains(n)) return true;
            if (shell && shell.contains(n)) return true;
            const menu = n.closest('[role="listbox"], .select__menu, [class*="Menu"], [class*="menu"]');
            if (!menu) return true;
            if (menu.closest('.iti, .phone-input, .phone-input__country')) return false;
            // Portaled Greenhouse react-select menus live outside the shell — allow them.
            return true;
        });
    }

    /** True while typeahead / async select is still fetching options. */
    function selectMenuIsLoading() {
        const nodes = [
            ...document.querySelectorAll(
                '[class*="loading"], [class*="spinner"], [aria-busy="true"], '
                + '.select__loading-indicator, [class*="loading-indicator"], '
                + '[role="option"], .select__option, [class*="menu"] [class*="option"], '
                + '[class*="listbox"] [class*="option"], .pac-item, [class*="no-options"], [class*="notice"]'
            )
        ];
        for (const n of nodes) {
            if (n.getClientRects().length === 0 && n.offsetParent === null) continue;
            const t = String(n.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const cls = String(n.className || '').toLowerCase();
            if (n.getAttribute?.('aria-busy') === 'true') return true;
            if (/loading|searching|please wait|fetching/.test(t)) return true;
            if (/loading-indicator|select__loading|is-loading|spinner/.test(cls) && n.getClientRects().length) {
                return true;
            }
        }
        // React-Select often puts aria-busy on the input/combobox while searching
        const busyInput = document.querySelector(
            'input[aria-busy="true"], [role="combobox"][aria-busy="true"], .select__control--is-loading'
        );
        if (busyInput && busyInput.getClientRects().length) return true;
        return false;
    }

    /**
     * Wait until real options appear (not "Loading…").
     * - While loading / incomplete → keep waiting
     * - As soon as options are ready → return (no long idle wait)
     * - If menu never loads and stays empty → bail early so we can type
     */
    async function waitForSelectOptions({
        timeoutMs = 8000,
        pollMs = 120,
        requireNotLoading = true,
        emptyBailMs = 700,
        anchorEl = null
    } = {}) {
        const start = Date.now();
        let last = [];
        let sawLoading = false;
        while (Date.now() - start < timeoutMs) {
            const loading = requireNotLoading && selectMenuIsLoading();
            if (loading) sawLoading = true;
            const opts = listOpenSelectOptions(anchorEl);
            last = opts;
            // Complete: options present and not loading → stop waiting immediately.
            if (!loading && opts.length > 0) {
                await delay(60);
                const settled = listOpenSelectOptions(anchorEl);
                if (settled.length > 0 && !selectMenuIsLoading()) {
                    return { ok: true, options: settled, waitedMs: Date.now() - start };
                }
            }
            // Incomplete but stuck empty (no spinner): don't burn the full timeout.
            const elapsed = Date.now() - start;
            if (!loading && opts.length === 0 && elapsed >= emptyBailMs && !sawLoading) {
                return {
                    ok: false,
                    options: last,
                    waitedMs: elapsed,
                    empty: true
                };
            }
            await delay(pollMs);
        }
        return {
            ok: last.length > 0 && !selectMenuIsLoading(),
            options: last,
            waitedMs: Date.now() - start,
            timeout: true
        };
    }

    function clickSelectOptionNode(best) {
        if (!best) return false;
        const helper = cm();
        if (helper) return helper.dispatchTrustedClick(best);
        best.scrollIntoView({ block: 'nearest' });
        best.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
        best.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        best.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        best.click();
        return true;
    }

    function closeReactSelect(el) {
        try {
            el?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            el?.blur();
        } catch (_) { /* ignore */ }
    }

    /** Menu catch-alls when the typed value is not in the list (wording varies by form). */
    function isCatchAllOptionText(text) {
        const t = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
        if (!t || t.length > 80) return false;
        if (/somewhere\s*else/i.test(t)) return true;
        return /^(other|others|other \(please specify\)|none of the above|none of these|not listed|not in (the )?list|outside (of )?(these|this)|prefer not to say|n\/a|does not apply|my (city|state|location) (is )?not listed)$/i.test(t);
    }

    function isUsStateOptionText(text) {
        return /^(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia|washington,? d\.?c\.?)$/i
            .test(String(text || '').trim());
    }

    function scoreOptionText(text, aliasList, kind = '') {
        const t = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
        if (!t) return -1;
        if (isCatchAllOptionText(t)) return -1; // never treat catch-all as a "match"
        if (kind === 'city' && /\b(mexico|méxico|queretaro|querétaro)\b/.test(t)) return -1;

        // Negation-aware gate for Yes/No / consent menus (Simplify / JobWizard pattern).
        const helper = cm();
        if (helper && aliasList?.length) {
            const primary = String(aliasList[0] || '').trim();
            if (helper.isAffirmative(primary) || helper.isNegative(primary)) {
                const gated = helper.scoreChoice(primary, text, '');
                if (gated < 0) return -1;
                if (gated >= 90) return gated;
            }
        }

        // Reside/city: never score a US-state-only option against a city name
        // (avoids picking "California" when the list is CA/FL/…/"Somewhere else").
        if (kind === 'city') {
            const cityOnly = String(aliasList[0] || '').split(',')[0].trim();
            if (cityOnly && !isUsStateOptionText(cityOnly) && isUsStateOptionText(t)) {
                return -1;
            }
        }

        let best = -1;
        for (const a of aliasList) {
            if (!a) continue;
            const al = String(a).toLowerCase().trim();
            if (!al) continue;
            // Ignore bare state / "CA" aliases when filling a city field.
            if (kind === 'city' && (isUsStateOptionText(al) || /^[a-z]{2}$/i.test(al))) continue;
            if (t === al) best = Math.max(best, 100);
            else if (t.startsWith(al + ' ') || t.startsWith(al + '+') || t.startsWith(al + ',') || t.startsWith(al + '(')) {
                best = Math.max(best, 92);
            } else if (al.length >= 3 && t.includes(al)) best = Math.max(best, 70);
            else if (al.length >= 4 && al.includes(t) && t.length >= 4) best = Math.max(best, 65);
        }
        // Degree menus often say "Bachelor's Degree" while profile has "Bachelor of Science".
        if (kind === 'degree') {
            const wantDeg = aliasList.join(' ').toLowerCase();
            if (/bachelor/.test(wantDeg) && /bachelor/.test(t) && !/master|doctor|associate|high\s*school/.test(t)) {
                best = Math.max(best, 88);
            }
            if (/master/.test(wantDeg) && /master/.test(t)) best = Math.max(best, 88);
            if (/\bph\.?d|doctor/.test(wantDeg) && /\bph\.?d|doctor/.test(t)) best = Math.max(best, 88);
        }
        if (kind === 'discipline') {
            const want = aliasList.join(' ').toLowerCase();
            if (/computer\s*science|\bcs\b/.test(want) && /computer\s*science|\bcs\b/.test(t)) {
                best = Math.max(best, 90);
            }
            if (/software\s*eng/.test(want) && /software\s*eng/.test(t)) best = Math.max(best, 90);
            if (/computer\s*eng/.test(want) && /computer\s*eng/.test(t)) best = Math.max(best, 90);
            if (/information\s*tech|\bit\b/.test(want) && /information\s*tech|\bit\b/.test(t)) {
                best = Math.max(best, 88);
            }
            if (/data\s*science/.test(want) && /data\s*science/.test(t)) best = Math.max(best, 90);
            if (/electrical/.test(want) && /electrical/.test(t)) best = Math.max(best, 88);
            // Soft: "Computer Science" ≈ "Computing" / "CS & Engineering"
            if (/computer/.test(want) && /computer/.test(t) && !/business|finance|biology|chemistry/.test(t)) {
                best = Math.max(best, 78);
            }
        }
        // Canonical / Greenhouse high-school performance menus (Top 5% / Top 25% / Above average…).
        if (kind === 'high_school_performance') {
            const want = aliasList.join(' ').toLowerCase();
            if (/top\s*5|top\s*10|excellent|outstanding/.test(want) && /top\s*5|top\s*10|excellent|outstanding/.test(t)) {
                best = Math.max(best, 92);
            }
            if (/above\s*average|top\s*25|good|strong|a\b/.test(want)
                && /above\s*average|top\s*25|good|strong|\ba\b|upper/.test(t)
                && !/below|bottom|poor/.test(t)) {
                best = Math.max(best, 88);
            }
            if (/average|top\s*50|median/.test(want) && /average|top\s*50|median/.test(t) && !/above|below|bottom/.test(t)) {
                best = Math.max(best, 80);
            }
            // Prefer strongest non-bottom option when wanted is "Above average".
            if (/above\s*average|top\s*25/.test(want) && /top\s*(5|10|25)\s*%/.test(t)) {
                best = Math.max(best, 90);
            }
        }
        return best;
    }

    /**
     * Read open menu → pick best match for aliases, or a catch-all if nothing matches.
     * Returns { ok, fallback }.
     * Education fields never auto-pick "Other" unless allowCatchAll is explicitly true
     * after typing failed.
     */
    function pickFromOpenOptions(preferred, {
        aliases = [], kind = '', allowCatchAll = true, minScore = 70, anchorEl = null
    } = {}) {
        const wantRaw = String(preferred || '').trim();
        const aliasList = [wantRaw, ...aliases].map((a) => String(a || '').trim()).filter(Boolean);
        const options = listOpenSelectOptions(anchorEl);
        if (!options.length) return { ok: false, fallback: false };

        const educationKind = kind === 'degree' || kind === 'discipline' || kind === 'school'
            || kind === 'education_level';
        // Never use catch-all for education on the first pass — "Other" is a last resort only.
        const useCatchAll = allowCatchAll && !educationKind;

        let best = null;
        let bestScore = -1;
        let catchAll = null;
        for (const o of options) {
            const label = String(o.textContent || '').replace(/\s+/g, ' ').trim();
            if (isCatchAllOptionText(label)) {
                catchAll = catchAll || o;
                continue;
            }
            const s = scoreOptionText(label, aliasList, kind);
            if (s > bestScore) {
                bestScore = s;
                best = o;
            }
        }

        if (best && bestScore >= minScore) {
            return { ok: clickSelectOptionNode(best), fallback: false, score: bestScore };
        }

        // Degree: fuzzy "Bachelor*" before ever considering Other.
        if (kind === 'degree') {
            const wantDeg = aliasList.join(' ').toLowerCase();
            for (const o of options) {
                const label = String(o.textContent || '').replace(/\s+/g, ' ').trim();
                if (isCatchAllOptionText(label)) continue;
                if (/bachelor/.test(wantDeg) && /bachelor/i.test(label)) {
                    return { ok: clickSelectOptionNode(o), fallback: false, score: 86 };
                }
            }
        }

        if (useCatchAll && catchAll) {
            return { ok: clickSelectOptionNode(catchAll), fallback: true, score: 0 };
        }

        // Explicit last-resort catch-all for education only when caller allows it.
        if (allowCatchAll && educationKind && catchAll) {
            return { ok: clickSelectOptionNode(catchAll), fallback: true, score: 0 };
        }

        // Yes/No / Agree special-case — never require literal "Yes" in the menu.
        const want = wantRaw.toLowerCase();
        const wantAffirm = want === 'yes' || want === 'y'
            || /^(i\s+)?(agree|acknowledge|consent)\b/.test(want)
            || /^yes\b/.test(want);
        const wantNeg = want === 'no' || want === 'n'
            || /^(i\s+)?(do\s+not|don't|disagree|decline|refuse)\b/.test(want)
            || /^no\b/.test(want);
        if (wantAffirm || wantNeg) {
            for (const o of options) {
                const t = String(o.textContent || '').trim();
                const tl = t.toLowerCase();
                if (wantAffirm) {
                    if (/\b(do\s+not|don't|disagree|decline|refuse|not agree)\b/i.test(t)) continue;
                    if (/^(yes|y)\b/i.test(t)
                        || /\bi\s+agree\b/i.test(t)
                        || /\backnowledge\b/i.test(t)
                        || /\bconsent\b/i.test(t)
                        || /^agree\b/i.test(t)) {
                        return { ok: clickSelectOptionNode(o), fallback: false, score: 95 };
                    }
                }
                if (wantNeg) {
                    if (/^(yes|y)\b/i.test(tl) && !/\bno\b/.test(tl)) continue;
                    if (/^(no|n)\b/i.test(t)
                        || /\bdo\s+not\b/i.test(t)
                        || /\bdon't\b/i.test(t)
                        || /\bdisagree\b/i.test(t)
                        || /\bdecline\b/i.test(t)) {
                        return { ok: clickSelectOptionNode(o), fallback: false, score: 95 };
                    }
                }
            }
        }

        return { ok: false, fallback: false, score: bestScore };
    }

    /** Type one character at a time so typeahead hints load; optionally pick mid-type. */
    async function typeComboboxSlowly(el, text, {
        perCharMs = 60,
        aliases = [],
        kind = '',
        pickWhileTyping = true,
        minScore = 85
    } = {}) {
        const full = String(text || '');
        if (!el || !full) return { ok: false, typed: '' };

        try {
            setNativeValue(el, '', { blur: false });
        } catch (_) { /* ignore */ }

        let built = '';
        for (let i = 0; i < full.length; i++) {
            const ch = full[i];
            built += ch;
            try {
                setNativeValue(el, built, { blur: false });
                el.dispatchEvent(new KeyboardEvent('keydown', {
                    key: ch, code: ch.length === 1 ? `Key${ch.toUpperCase()}` : ch, bubbles: true, cancelable: true
                }));
                el.dispatchEvent(new KeyboardEvent('keyup', {
                    key: ch, bubbles: true, cancelable: true
                }));
            } catch (_) { /* ignore */ }

            await delay(perCharMs);

            // After a few chars, wait for loading to finish before early-picking.
            if (pickWhileTyping && built.trim().length >= 3 && (i === full.length - 1 || i % 2 === 1)) {
                if (selectMenuIsLoading()) {
                    await waitForSelectOptions({ timeoutMs: 2500, pollMs: 150 });
                }
                const hit = pickFromOpenOptions(built, {
                    aliases: [built, ...aliases],
                    kind,
                    allowCatchAll: false,
                    minScore,
                    anchorEl: el
                });
                if (hit.ok) return { ok: true, typed: built, early: true };
            }
        }

        // Always wait for async typeahead results after typing finishes — but stop as soon as ready.
        await waitForSelectOptions({ timeoutMs: 5000, pollMs: 120, emptyBailMs: 600 });
        return { ok: false, typed: built };
    }

    function scheduleYesNoCombobox(el, preferred) {
        const wantRaw = String(preferred || '').trim();
        if (!wantRaw || !el) return;
        const want = wantRaw.toLowerCase().startsWith('yes')
            ? 'Yes'
            : wantRaw.toLowerCase().startsWith('no')
                ? 'No'
                : wantRaw;
        scheduleHumanCombobox(el, want, { kind: 'yesno', minScore: 70 });
    }

    /**
     * Native <select> — human method:
     * 1) click to open  2) read option items  3) find match  4) choose it  5) verify
     * Never silently assign .value without opening / matching visible options.
     */
    async function fillNativeSelectHuman(el, preferred, kind = '', salaryPick = null) {
        const want = String(preferred || '').trim();
        if (!el || el.tagName !== 'SELECT' || !want) return false;

        try {
            el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } catch (_) { /* ignore */ }

        // 1) Click open (like a human)
        const helper = cm();
        if (helper) helper.dispatchTrustedClick(el);
        else {
            el.focus();
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            el.click();
        }
        await delay(180);

        // 2) See the items (all options the menu would show)
        const allOpts = [...el.options];
        const visibleOpts = allOpts.filter((o) => {
            const t = String(o.text || '').trim();
            return t && !/^select(\s|\.|…|\.\.\.|:)?$/i.test(t);
        });
        const opts = visibleOpts.length ? visibleOpts : allOpts;

        const stMap = {
            ca: 'California', ny: 'New York', tx: 'Texas', wa: 'Washington',
            fl: 'Florida', il: 'Illinois', ma: 'Massachusetts', or: 'Oregon',
            co: 'Colorado', az: 'Arizona', ga: 'Georgia', nc: 'North Carolina',
            pa: 'Pennsylvania', va: 'Virginia', nj: 'New Jersey', md: 'Maryland',
            oh: 'Ohio', mi: 'Michigan', mn: 'Minnesota', wi: 'Wisconsin',
            in: 'Indiana', tn: 'Tennessee', mo: 'Missouri', sc: 'South Carolina'
        };
        const aliases = (() => {
            const list = [want];
            if (want.includes(',')) list.push(want.split(',').pop().trim());
            const k = want.toLowerCase();
            if (stMap[k]) list.push(stMap[k], k.toUpperCase());
            const entry = Object.entries(stMap).find(([, v]) => v.toLowerCase() === k);
            if (entry) list.push(entry[0].toUpperCase(), entry[1]);
            return [...new Set(list.filter(Boolean))];
        })();

        // 3) Find matching item among what we see
        const salaryHint = salaryPick && (salaryPick.value != null || salaryPick.formatted)
            ? { value: salaryPick.value, formatted: salaryPick.formatted || want }
            : { formatted: want, value: want };
        let match = null;
        if (kind === 'salary') {
            match = matchSalaryOption(allOpts, salaryHint);
        }
        if (!match) {
            for (const alias of aliases) {
                match = matchSelectOption(opts, alias);
                if (match) break;
            }
        }
        if (!match && kind === 'salary') {
            match = matchSalaryOption(allOpts, salaryHint);
        }
        if (!match && (kind === 'data_protection' || /\b(acknowledg|agree|consent)\b/i.test(want))) {
            match = matchSelectOption(opts, 'I acknowledge')
                || matchSelectOption(opts, 'I agree');
        }
        if (!match) {
            try { el.blur(); } catch (_) { /* ignore */ }
            return false;
        }

        // 4) Choose it
        const idx = allOpts.indexOf(match);
        if (idx >= 0) el.selectedIndex = idx;
        el.value = match.value;
        try { match.selected = true; } catch (_) { /* ignore */ }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        try {
            match.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        } catch (_) { /* ignore */ }
        await delay(80);

        // 5) Verify
        const chosen = (el.options[el.selectedIndex]?.text || el.value || '').trim();
        let ok = valuesRoughlyMatch(want, chosen, kind)
            || aliases.some((a) => valuesRoughlyMatch(a, chosen, kind === 'city' ? 'state' : kind))
            || (helper?.scoreChoice(want, chosen, match.value || '') >= 65);
        if (!ok && (kind === 'city' || kind === 'state')) {
            // State select: CA / California / Palo Alto, CA all OK once an option is chosen
            if (el.selectedIndex > 0 && match && chosen && !/^select/i.test(chosen)) ok = true;
        }
        if (!ok && kind === 'salary') {
            if (el.selectedIndex > 0 && match) ok = true;
        }
        if (!ok && (kind === 'work_authorization' || kind === 'requires_sponsorship'
            || kind === 'over_18' || kind === 'previous_employer_no' || kind === 'data_protection')) {
            const canon = helper?.canonicalizeWant?.(want) || want;
            if (helper?.scoreChoice(canon, chosen, match.value || '') >= 65) ok = true;
        }
        if (!ok && kind === 'data_protection') {
            if (/\b(acknowledg|agree|consent|yes)\b/i.test(chosen)
                && !/\b(do not|don't|decline|refuse)\b/i.test(chosen)) {
                ok = true;
            }
        }
        return !!ok;
    }

    /**
     * Simplify / JobWizard-style select fill:
     * React fiber onChange (best) → open/wait/click → type → ArrowDown+Enter → VERIFY → retry.
     * Never leave placeholder "Select..." when we have a wanted value.
     */
    function getReactFiber(el) {
        if (!el) return null;
        const key = Object.keys(el).find((k) => (
            k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
        ));
        return key ? el[key] : null;
    }

    function findReactSelectProps(el) {
        const startEls = [
            el?.closest?.('.select__control, [class*="select__control"], [class*="Select"]'),
            el,
            el?.parentElement
        ].filter(Boolean);
        for (const start of startEls) {
            let fiber = getReactFiber(start);
            let depth = 0;
            while (fiber && depth < 40) {
                const props = fiber.memoizedProps || {};
                if (props.selectProps && (props.options || props.selectOption || props.setValue
                    || props.selectProps?.onChange || props.selectProps?.loadOptions)) {
                    return {
                        selectProps: props.selectProps,
                        options: props.options || props.selectProps.options || [],
                        setValue: typeof props.setValue === 'function' ? props.setValue : null,
                        selectOption: typeof props.selectOption === 'function' ? props.selectOption : null,
                        getValue: typeof props.getValue === 'function' ? props.getValue : null
                    };
                }
                if (typeof props.onChange === 'function' && (props.options || props.loadOptions)) {
                    return {
                        selectProps: props,
                        options: props.options || [],
                        setValue: typeof props.setValue === 'function' ? props.setValue : null,
                        selectOption: typeof props.selectOption === 'function' ? props.selectOption : null,
                        getValue: typeof props.getValue === 'function' ? props.getValue : null
                    };
                }
                // Greenhouse remix: setValue/options live on Select control fiber without nested selectProps.onChange.
                if ((typeof props.setValue === 'function' || typeof props.selectOption === 'function')
                    && Array.isArray(props.options) && props.options.length) {
                    return {
                        selectProps: props.selectProps || props,
                        options: props.options,
                        setValue: typeof props.setValue === 'function' ? props.setValue : null,
                        selectOption: typeof props.selectOption === 'function' ? props.selectOption : null,
                        getValue: typeof props.getValue === 'function' ? props.getValue : null
                    };
                }
                fiber = fiber.return;
                depth += 1;
            }
        }
        return null;
    }

    /** Labels from React-Select fiber (for AI choice prompts + snap). */
    function listReactSelectOptionLabels(el) {
        try {
            const found = findReactSelectProps(el);
            if (!found) return [];
            const flatten = (list) => (list || []).flatMap((o) => (o?.options ? flatten(o.options) : [o]));
            return flatten(found.options || found.selectProps?.options || [])
                .map((o) => String(o?.label ?? o?.name ?? o?.value ?? '').trim())
                .filter((t) => t && !/^select(\.\.\.|…|:)?$/i.test(t) && t.length < 160)
                .slice(0, 40);
        } catch (_) {
            return [];
        }
    }

    function matchReactOption(flat, wantRaw, aliases = [], kind = '') {
        const aliasList = [wantRaw, ...aliases].map((a) => String(a || '').toLowerCase().trim()).filter(Boolean);
        const scoreOne = (opt) => {
            const label = String(opt?.label ?? opt?.name ?? opt?.value ?? '').trim();
            if (!label || isCatchAllOptionText(label)) return -1;
            return scoreOptionText(label, [wantRaw, ...aliases], kind);
        };
        let best = null;
        let bestScore = -1;
        for (const opt of flat) {
            const s = scoreOne(opt);
            if (s > bestScore) {
                bestScore = s;
                best = opt;
            }
        }
        if (best && bestScore >= 60) return best;
        // Soft CS / Bachelor fallbacks
        for (const opt of flat) {
            const label = String(opt?.label ?? opt?.name ?? '').toLowerCase();
            for (const a of aliasList) {
                if (/computer/.test(a) && /computer|computing/.test(label)) return opt;
                if (/bachelor/.test(a) && /bachelor/.test(label)) return opt;
            }
        }
        return null;
    }

    async function fillViaReactSelect(el, wantRaw, aliases = [], { allowAsync = false, asyncTimeoutMs = 1800, kind = '' } = {}) {
        const found = findReactSelectProps(el);
        if (!found) return false;
        const { selectProps, options, setValue, selectOption } = found;
        if (!selectProps?.onChange && !setValue && !selectOption) return false;
        const flatten = (list) => (list || []).flatMap((o) => (o?.options ? flatten(o.options) : [o]));
        const aliasList = Array.isArray(aliases) ? aliases : [];

        // Sync options first — instant, no wait before typing.
        let flat = flatten(options || selectProps?.options || []);
        let hit = matchReactOption(flat, wantRaw, aliasList, kind);
        if (hit) {
            try { setValue?.(hit, 'select-option'); } catch (_) { /* ignore */ }
            try { selectOption?.(hit); } catch (_) { /* ignore */ }
            try {
                selectProps?.onChange?.(hit, { action: 'select-option', option: hit });
            } catch (_) { /* ignore */ }
            // React needs a tick to paint .select__single-value.
            await delay(120);
            return true;
        }

        // Async only when caller allows (after typing) — never block input on this.
        if (!allowAsync || typeof selectProps?.loadOptions !== 'function') return false;

        const q = String(wantRaw || '').trim().slice(0, 24);
        if (q.length < 2) return false;
        try {
            const res = await new Promise((resolve, reject) => {
                let settled = false;
                const done = (v) => {
                    if (settled) return;
                    settled = true;
                    resolve(v);
                };
                try {
                    const ret = selectProps.loadOptions(q, done);
                    if (ret && typeof ret.then === 'function') ret.then(done, reject);
                } catch (err) {
                    reject(err);
                }
                setTimeout(() => done([]), asyncTimeoutMs);
            });
            const loaded = flatten(res?.options || res || []);
            hit = matchReactOption(loaded, wantRaw, aliasList, kind);
            if (!hit && loaded.length === 1 && !isCatchAllOptionText(loaded[0]?.label)) {
                hit = loaded[0];
            }
            if (hit) {
                try { setValue?.(hit, 'select-option'); } catch (_) { /* ignore */ }
                try { selectOption?.(hit); } catch (_) { /* ignore */ }
                try {
                    selectProps?.onChange?.(hit, { action: 'select-option', option: hit });
                } catch (_) { /* ignore */ }
                await delay(120);
                return true;
            }
        } catch (_) { /* ignore */ }
        return false;
    }

    async function commitComboboxWithKeyboard(el) {
        if (!el) return;
        // iti registers document keydown while its dial list is open — Escape first or
        // ArrowDown/Enter selects Afghanistan instead of the intended option.
        dismissPhoneDialUi();
        await delay(40);
        if (document.querySelector(
            '.iti__country-list:not(.iti__hide), .iti__dropdown-content:not(.iti__hide)'
        )) {
            dismissPhoneDialUi();
            await delay(40);
        }
        const keys = [
            { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
            { key: 'Enter', code: 'Enter', keyCode: 13 }
        ];
        for (const k of keys) {
            try {
                el.dispatchEvent(new KeyboardEvent('keydown', {
                    ...k, bubbles: true, cancelable: true, which: k.keyCode
                }));
                el.dispatchEvent(new KeyboardEvent('keyup', {
                    ...k, bubbles: true, cancelable: true, which: k.keyCode
                }));
            } catch (_) { /* ignore */ }
            await delay(50);
        }
        dismissPhoneDialUi();
    }

    async function fillComboboxSimplify(el, preferred, {
        kind = '',
        aliases = [],
        maxAttempts = 3,
        minScore = 65
    } = {}) {
        const wantRaw = String(preferred || '').trim();
        if (!wantRaw || !el) return false;
        const aliasList = [...new Set([wantRaw, ...aliases].map((a) => String(a || '').trim()).filter(Boolean))];
        const helper = cm();
        // Static choice menus (not city/school typeahead): open → read → click.
        // Typing a preferred phrase that is not in the list leaves "No options" garbage.
        const typeaheadKind = kind === 'discipline' || kind === 'school' || kind === 'city'
            || kind === 'country' || kind === 'state' || kind === 'degree';
        const staticChoiceKind = !typeaheadKind
            || kind === 'high_school_performance'
            || kind === 'yesno'
            || kind === 'data_protection'
            || kind === 'employer_count'
            || kind === 'years_of_experience'
            || kind === 'skill_experience'
            || /^education_(start|end)_/.test(kind)
            || kind === 'how_heard'
            || kind === 'work_authorization'
            || kind === 'requires_sponsorship'
            || kind === 'previous_employer_no'
            || kind === 'disability_status'
            || kind === 'over_18'
            || kind === 'willing_to_relocate';

        const clearTypedFilter = () => {
            try {
                setNativeValue(el, '', { blur: false });
                const clearBtn = el.closest(
                    '.select-shell, [class*="select-shell"], .select__control, [class*="select__control"], [class*="Select"]'
                )?.querySelector?.(
                    '.select__clear-indicator, [class*="clear-indicator"], [aria-label="Clear"]'
                );
                if (clearBtn) clearBtn.click();
            } catch (_) { /* ignore */ }
        };

        const readDisplayed = () => {
            // Never treat the filter input's typed text as the selected value.
            const root = el.closest(
                '.select-shell, [class*="select-shell"], .select__control, [class*="select__control"], [class*="Select"]'
            ) || el.parentElement;
            const single = root?.querySelector?.('.select__single-value, [class*="single-value"], [class*="singleValue"]');
            const placeholder = root?.querySelector?.('.select__placeholder, [class*="placeholder"]');
            const t = single
                ? String(single.textContent || '').replace(/\s+/g, ' ').trim()
                : '';
            // Visible placeholder means nothing selected yet.
            if (placeholder) {
                try {
                    const phVisible = placeholder.getClientRects?.().length > 0
                        || getComputedStyle(placeholder).display !== 'none';
                    if (phVisible && (!t || /^select(\.\.\.|…|:)?$/i.test(t))) return '';
                } catch (_) { /* ignore */ }
            }
            if (!t || /^select(\.\.\.|…|:)?$/i.test(t) || /^choose/i.test(t)) return '';
            return t;
        };

        const verified = () => {
            const got = readDisplayed();
            if (!got) return false;
            if (valuesRoughlyMatch(wantRaw, got)) return true;
            if (helper && helper.scoreChoice(wantRaw, got, '') >= 70) return true;
            for (const a of aliasList) {
                if (valuesRoughlyMatch(a, got)) return true;
                if (helper && helper.scoreChoice(a, got, '') >= 70) return true;
            }
            if (kind === 'discipline') {
                const w = wantRaw.toLowerCase();
                const g = got.toLowerCase();
                if (/computer/.test(w) && /computer|computing|\bcs\b/.test(g)) return true;
            }
            if (kind === 'degree') {
                const w = wantRaw.toLowerCase();
                const g = got.toLowerCase();
                if (/bachelor/.test(w) && /bachelor/.test(g)) return true;
                if (/master/.test(w) && /master/.test(g)) return true;
            }
            if (kind === 'high_school_performance') {
                const w = aliasList.join(' ').toLowerCase();
                const g = got.toLowerCase();
                const wantStrong = /above|top\s*(5|10|25)|excellent|good|strong|upper/.test(w);
                const gotStrong = /above|top\s*(5|10|25)|excellent|good|strong|upper|\ba\b/.test(g)
                    && !/below|bottom|poor/.test(g);
                if (wantStrong && gotStrong) return true;
            }
            // Consent / Yes menus: Agree / Acknowledge counts as success for preferred Yes.
            if (kind === 'data_protection' || kind === 'yesno'
                || /^(yes|y|i agree|i acknowledge)$/i.test(wantRaw)) {
                const g = got.toLowerCase();
                const wantYes = /^(yes|y)\b/i.test(wantRaw)
                    || /agree|acknowledge|consent/i.test(wantRaw);
                if (wantYes
                    && /^(yes|y)\b|agree|acknowledge|consent/i.test(g)
                    && !/\b(do\s+not|don't|disagree|decline|refuse)\b/i.test(g)) {
                    return true;
                }
            }
            return false;
        };

        // Already complete → do not wait / reopen.
        if (verified()) return true;

        // Instant sync React options only (no async wait before typing).
        if (await fillViaReactSelect(el, wantRaw, aliasList, { allowAsync: false, kind })) {
            if (await waitUntil(verified, { timeoutMs: 900, pollMs: 40 })) {
                closeReactSelect(el);
                return true;
            }
            // Second fiber set — first paint can lag on Greenhouse remix.
            await fillViaReactSelect(el, wantRaw, aliasList, { allowAsync: false, kind });
            if (await waitUntil(verified, { timeoutMs: 700, pollMs: 40 })) {
                closeReactSelect(el);
                return true;
            }
            // Static Yes/No: trust fiber getValue when single-value is slow to paint.
            if (!typeaheadKind) {
                try {
                    const found = findReactSelectProps(el);
                    const got = found?.getValue?.() || found?.selectProps?.getValue?.() || [];
                    const vals = Array.isArray(got) ? got : (got ? [got] : []);
                    for (const v of vals) {
                        const lab = String(v?.label ?? v?.value ?? v ?? '').trim();
                        if (lab && (valuesRoughlyMatch(wantRaw, lab) || aliasList.some((a) => valuesRoughlyMatch(a, lab)))) {
                            closeReactSelect(el);
                            return true;
                        }
                    }
                } catch (_) { /* ignore */ }
            }
        }

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (verified()) {
                closeReactSelect(el);
                return true;
            }

            openReactSelect(el, { clear: false }); // never clear a good value mid-retry
            // Static Yes/No / EEO: brief peek. Typeahead: type immediately — do NOT wait first.
            if (!typeaheadKind) {
                await waitForSelectOptions({ timeoutMs: 900, pollMs: 60, emptyBailMs: 180, anchorEl: el });
                if (verified()) {
                    closeReactSelect(el);
                    return true;
                }
                const quick = pickFromOpenOptions(wantRaw, {
                    aliases: aliasList, kind, allowCatchAll: false, minScore, anchorEl: el
                });
                if (quick.ok) {
                    try {
                        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
                        el.blur();
                    } catch (_) { /* ignore */ }
                    if (await waitUntil(verified, { timeoutMs: 700, pollMs: 30 })) return true;
                }
            } else if (listOpenSelectOptions(el).length) {
                const quick = pickFromOpenOptions(wantRaw, {
                    aliases: aliasList, kind, allowCatchAll: false, minScore, anchorEl: el
                });
                if (quick.ok && await waitUntil(verified, { timeoutMs: 500, pollMs: 30 })) return true;
            }

            // INPUT FIRST — typeahead menus need keystrokes before options exist.
            // Static choice menus: never type preferred text (causes "No options" when
            // the phrase is not in the list, e.g. "Above average" / bare "Yes").
            if (!staticChoiceKind) {
                const filter = wantRaw.slice(0, Math.min(attempt === 1 ? 14 : 28, wantRaw.length));
                // Only wipe filter text when display is still empty / placeholder.
                if (!readDisplayed()) {
                    try { setNativeValue(el, '', { blur: false }); } catch (_) { /* ignore */ }
                }
                try { el.focus(); } catch (_) { /* ignore */ }
                const typed = await typeComboboxSlowly(el, filter, {
                    perCharMs: 35,
                    aliases: aliasList,
                    kind,
                    pickWhileTyping: true,
                    minScore: kind === 'city' ? 55 : Math.max(minScore, 70)
                });
                if (typed.ok) {
                    if (await waitUntil(verified, { timeoutMs: 600, pollMs: 30 })) return true;
                }
            } else {
                // Re-open and re-read full list (no filter).
                clearTypedFilter();
                openReactSelect(el, { clear: false });
                await waitForSelectOptions({
                    timeoutMs: 1400,
                    pollMs: 80,
                    emptyBailMs: 250,
                    anchorEl: el
                });
            }

            // Wait only while still incomplete after typing.
            if (!verified()) {
                await waitForSelectOptions({
                    timeoutMs: typeaheadKind ? 5000 : 1800,
                    pollMs: 100,
                    emptyBailMs: typeaheadKind ? 900 : 300,
                    anchorEl: el
                });
            }
            if (verified()) {
                closeReactSelect(el);
                return true;
            }

            const eduKind = kind === 'school' || kind === 'degree' || kind === 'discipline'
                || kind === 'education_level';
            const hit = pickFromOpenOptions(wantRaw, {
                aliases: aliasList,
                kind,
                allowCatchAll: !eduKind && attempt === maxAttempts,
                minScore: attempt === maxAttempts ? Math.max(50, minScore - 15) : minScore,
                anchorEl: el
            });
            if (hit.ok) {
                try {
                    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
                    el.blur();
                } catch (_) { /* ignore */ }
                if (await waitUntil(verified, { timeoutMs: 700, pollMs: 30 })) return true;
                // Clicked a real menu row — accept displayed value for static choice menus.
                if (staticChoiceKind && readDisplayed()) {
                    closeReactSelect(el);
                    return true;
                }
            }

            if (!verified() && !staticChoiceKind) {
                await commitComboboxWithKeyboard(el);
                if (await waitUntil(verified, { timeoutMs: 500, pollMs: 30 })) return true;
            }

            if (!verified() && await fillViaReactSelect(el, wantRaw, aliasList, {
                allowAsync: !staticChoiceKind,
                asyncTimeoutMs: 1500,
                kind
            })) {
                if (await waitUntil(verified, { timeoutMs: 500, pollMs: 30 })) return true;
            }

            if (verified()) {
                closeReactSelect(el);
                return true;
            }

            // Never clear a displayed value that already looks correct — that caused
            // "I chose it / system chooses again" infinite loops on Disability Status.
            const shown = readDisplayed();
            if (shown && helper && helper.scoreChoice(wantRaw, shown, '') >= 55) {
                closeReactSelect(el);
                return true;
            }
            // Wipe leftover filter text like "Above average" / "Yes" with "No options".
            if (!shown) clearTypedFilter();
            closeReactSelect(el);
            await delay(80);
        }

        if (!verified()) clearTypedFilter();
        return verified();
    }

    /**
     * Human-like combobox / custom select (Greenhouse React-Select, etc.):
     *   1) click open
     *   2) see the menu items
     *   3) find the match
     *   4) click that item
     *   5) VERIFY displayed value — retry if still "Select..."
     */
    function scheduleHumanCombobox(el, preferred, { kind = '', minScore = 70, aliases = [] } = {}) {
        const wantRaw = String(preferred || '').trim();
        if (!wantRaw || !el) return Promise.resolve(false);
        const aliasList = [wantRaw, ...aliases].filter(Boolean);

        return new Promise((outerResolve) => {
            enqueueCombobox(() => fillComboboxSimplify(el, wantRaw, {
                kind,
                aliases: aliasList,
                maxAttempts: 3,
                minScore
            }).then((ok) => {
                outerResolve(ok);
                return ok;
            }).catch(() => {
                outerResolve(false);
                return false;
            }));
        });
    }

    function scheduleLocationAutocomplete(el, preferred, kind = '', profile = null) {
        const wantRaw = String(preferred || '').trim();
        if (!wantRaw || !el) return Promise.resolve(false);
        const profileState = String(profile?.state || '').trim();
        const stateFull = (() => {
            const map = {
                ca: 'California', ny: 'New York', tx: 'Texas', wa: 'Washington',
                fl: 'Florida', il: 'Illinois', ma: 'Massachusetts', or: 'Oregon',
                co: 'Colorado', az: 'Arizona', ga: 'Georgia', nc: 'North Carolina',
                pa: 'Pennsylvania', va: 'Virginia', nj: 'New Jersey', md: 'Maryland',
                nm: 'New Mexico'
            };
            return map[profileState.toLowerCase()] || profileState;
        })();

        const aliases = (() => {
            const list = [wantRaw];
            if (kind === 'country' || /united states|usa|\bu\.?s\.?\b/i.test(wantRaw)) {
                list.push('United States', 'United States of America', 'USA', 'US', 'U.S.', 'U.S.A.');
            }
            if (kind === 'state') {
                if (stateFull) list.push(stateFull, profileState);
            }
            if (kind === 'city') {
                // "Where are you located?" often is a US-state select, not a city typeahead.
                if (stateFull) list.push(stateFull, profileState, `${wantRaw.split(',')[0].trim()}, ${stateFull}`);
                if (profileState && /^[A-Z]{2}$/i.test(profileState)) list.push(profileState.toUpperCase());
            }
            if (kind === 'school') {
                list.push(wantRaw.replace(/\buniversity\b/i, '').trim(), 'Virginia Polytechnic', 'Virginia Tech');
            }
            if (kind === 'degree') {
                list.push(
                    'Bachelor of Science',
                    "Bachelor's Degree",
                    "Bachelor's",
                    'Bachelors',
                    'Bachelor',
                    'B.S.',
                    'BS',
                    'B.S',
                    "Master's Degree",
                    'Master of Science'
                );
            }
            if (kind === 'discipline') {
                list.push(
                    'Computer Science',
                    'CS',
                    'Computer Science & Engineering',
                    'Computer Science and Engineering',
                    'Computing',
                    'Software Engineering',
                    'Computer Engineering',
                    'Information Technology',
                    'IT',
                    'Information Systems',
                    'Data Science',
                    'Electrical Engineering',
                    'Engineering'
                );
                const head = wantRaw.split(/[\s,/&-]+/).filter((w) => w.length > 2)[0];
                if (head) list.push(head);
            }
            if (kind === 'skill_experience' || kind === 'years_of_experience') {
                list.push(...skillExperienceFillAliases(profile, wantRaw));
            }
            if (/^education_(start|end)_month$/.test(kind)) {
                list.push(
                    'January', 'February', 'March', 'April', 'May', 'June',
                    'July', 'August', 'September', 'October', 'November', 'December'
                );
            }
            if (wantRaw.includes(',')) list.push(wantRaw.split(',')[0].trim());
            return [...new Set(list.filter(Boolean))];
        })();

        if (kind === 'high_school_performance') {
            aliases.push(
                'Above average',
                'Top 25%',
                'Top 25% of class',
                'Top 10%',
                'Top 10% of class',
                'Top 5%',
                'Excellent',
                'Good',
                'Strong',
                'A',
                'Upper quartile'
            );
        }

        // Education / country / state / high-school: Simplify verify+retry path
        if (kind === 'school' || kind === 'degree' || kind === 'discipline'
            || kind === 'education_level' || kind === 'country' || kind === 'state'
            || kind === 'high_school_performance'
            || kind === 'skill_experience' || kind === 'years_of_experience'
            || /^education_(start|end)_/.test(kind)) {
            return new Promise((outerResolve) => {
                enqueueCombobox(() => fillComboboxSimplify(el, wantRaw, {
                    kind,
                    aliases: [...new Set(aliases.filter(Boolean))],
                    maxAttempts: 3,
                    minScore: kind === 'discipline' || kind === 'high_school_performance'
                        || kind === 'skill_experience' || kind === 'years_of_experience'
                        || /^education_(start|end)_/.test(kind)
                        ? 55
                        : 65
                }).then((ok) => {
                    outerResolve(ok);
                    return ok;
                }).catch(() => {
                    outerResolve(false);
                    return false;
                }));
            });
        }

        const typeAttempts = (() => {
            const cityOnly = wantRaw.includes(',') ? wantRaw.split(',')[0].trim() : wantRaw;
            const seq = [];
            if (kind === 'city') {
                seq.push(cityOnly);
                if (wantRaw !== cityOnly) seq.push(wantRaw);
            } else {
                seq.push(wantRaw);
                if (cityOnly && cityOnly !== wantRaw) seq.push(cityOnly);
            }
            return [...new Set(seq.filter(Boolean))];
        })();

        return new Promise((outerResolve) => {
            enqueueCombobox(() => new Promise((resolve) => {
                const done = (ok) => {
                    resolve(ok);
                    outerResolve(ok);
                };
                (async () => {
                    openReactSelect(el);
                    // City typeahead: type immediately — don't wait before input.
                    if (listOpenSelectOptions(el).length) {
                        let hit = pickFromOpenOptions(wantRaw, {
                            aliases, kind, allowCatchAll: false, minScore: 70, anchorEl: el
                        });
                        if (hit.ok) {
                            closeReactSelect(el);
                            done(true);
                            return;
                        }
                        if (kind === 'city') {
                            const cityOnly = wantRaw.includes(',') ? wantRaw.split(',')[0].trim() : wantRaw;
                            const cityAliases = [cityOnly, wantRaw].filter(Boolean);
                            const exact = pickFromOpenOptions(cityOnly, {
                                aliases: cityAliases,
                                kind: 'city',
                                allowCatchAll: false,
                                minScore: 85,
                                anchorEl: el
                            });
                            if (exact.ok) {
                                closeReactSelect(el);
                                done(true);
                                return;
                            }
                            const fallback = pickFromOpenOptions(cityOnly, {
                                aliases: cityAliases,
                                kind: 'city',
                                allowCatchAll: true,
                                minScore: 95,
                                anchorEl: el
                            });
                            if (fallback.ok) {
                                closeReactSelect(el);
                                done(true);
                                return;
                            }
                        }
                    }

                    for (let ai = 0; ai < typeAttempts.length; ai++) {
                        const attempt = typeAttempts[ai];
                        openReactSelect(el);
                        try { setNativeValue(el, '', { blur: false }); } catch (_) { /* ignore */ }
                        const typed = await typeComboboxSlowly(el, attempt, {
                            perCharMs: 35,
                            aliases,
                            kind: 'city',
                            pickWhileTyping: true,
                            minScore: 85
                        });
                        if (typed.ok) {
                            closeReactSelect(el);
                            done(true);
                            return;
                        }
                        await waitForSelectOptions({
                            timeoutMs: 5000, pollMs: 120, emptyBailMs: 800, anchorEl: el
                        });
                        const hit = pickFromOpenOptions(attempt, {
                            aliases: [attempt, wantRaw],
                            kind: 'city',
                            allowCatchAll: true,
                            minScore: 85,
                            anchorEl: el
                        });
                        if (hit.ok) {
                            closeReactSelect(el);
                            done(true);
                            return;
                        }
                    }

                    try { setNativeValue(el, '', { blur: false }); } catch (_) { /* ignore */ }
                    openReactSelect(el);
                    await waitForSelectOptions({
                        timeoutMs: 2000, pollMs: 100, emptyBailMs: 400, anchorEl: el
                    });
                    const last = pickFromOpenOptions(wantRaw, {
                        aliases: [wantRaw.split(',')[0].trim(), wantRaw],
                        kind,
                        allowCatchAll: true,
                        minScore: 90,
                        anchorEl: el
                    });
                    closeReactSelect(el);
                    if (last.ok) {
                        done(true);
                        return;
                    }

                    // Dropdown miss — site often asks for city, state, zip manually.
                    const freeText = formatLocationFreeText(profile, wantRaw);
                    const wantManual = isLocationManualEntryHint(el, '')
                        || kind === 'city'
                        || /location/i.test(String(el?.getAttribute?.('aria-label') || el?.placeholder || ''));
                    if (freeText && wantManual) {
                        try {
                            openReactSelect(el);
                            try { setNativeValue(el, '', { blur: false }); } catch (_) { /* ignore */ }
                            await typeComboboxSlowly(el, freeText, {
                                perCharMs: 28,
                                aliases: [freeText],
                                kind: 'city',
                                pickWhileTyping: false,
                                minScore: 99
                            });
                            setNativeValue(el, freeText, { blur: true });
                            closeReactSelect(el);
                            const got = String(el.value || el.textContent || '').trim();
                            if (got.length >= 3) {
                                done(true);
                                return;
                            }
                        } catch (_) { /* ignore */ }
                    }
                    done(false);
                })().catch(() => {
                    closeReactSelect(el);
                    done(false);
                });
            }));
        });
    }

    function dropzoneAncestor(el) {
        if (!el?.closest) return el?.parentElement || null;
        return el.closest(
            'label, [class*="drop"], [class*="upload"], [class*="file"], [class*="attach"], '
            + '[class*="Document"], [data-testid*="resume"], [data-testid*="upload"], '
            + 'fieldset, .field, .form-field, [class*="Field"], [class*="form-control"]'
        ) || el.parentElement;
    }

    function nearbyUploadLabel(input) {
        if (!input) return '';
        const wrap = dropzoneAncestor(input);
        return [
            input.getAttribute('aria-label') || '',
            input.getAttribute('title') || '',
            input.id || '',
            input.name || '',
            wrap?.innerText || wrap?.textContent || ''
        ].join(' ').replace(/\s+/g, ' ').trim().slice(0, 600);
    }

    function fileInputKind(input) {
        const idHay = `${input.id || ''} ${input.name || ''}`.toLowerCase();
        if (/^cover_letter$|cover[\s_-]*letter/i.test(idHay)) return 'cover_letter';
        if (/^resume$|\bresum|\bcv\b/i.test(idHay)) return 'resume';
        const label = labelFor(input);
        const nearby = nearbyUploadLabel(input);
        const kind = classifyPersonal(label, input.name || '', input.getAttribute('data-automation-id') || '');
        const hay = `${label} ${nearby} ${input.name || ''}`.toLowerCase();
        if (kind === 'cover_letter' || /\b(cover[\s_-]*letter|covering[\s_-]*letter|motivation[\s_-]*letter)\b/.test(hay)) {
            return 'cover_letter';
        }
        if (kind === 'resume' || /\b(resume|r[ée]sum[eé]|cv|curriculum[\s_-]*vitae)\b/.test(hay)) {
            return 'resume';
        }
        // Rippling / generic dropzones: "Drop or select (.doc / .docx / .pdf)" under Résumé*
        if (/drop or select/i.test(nearby) && /\.docx?|\.pdf/i.test(nearby)) return 'resume';
        return 'other';
    }

    function listFileInputsForUpload() {
        return [...document.querySelectorAll('input[type="file"]')].filter((el) => {
            if (!el || el.disabled) return false;
            const wrap = dropzoneAncestor(el);
            if (wrap) {
                const cr = wrap.getBoundingClientRect();
                if (cr.width > 4 && cr.height > 4) return true;
            }
            const label = nearbyUploadLabel(el);
            if (/\b(r[ée]sum[eé]|cv|curriculum)\b/i.test(label) || /drop or select|\.docx|\.pdf/i.test(label)) {
                return true;
            }
            return visible(el);
        });
    }

    function fileSlotLooksFilled(input) {
        if (input?.files && input.files.length > 0) return true;
        const wrap = dropzoneAncestor(input);
        const t = String(wrap?.innerText || '').slice(0, 400);
        return /\.(docx?|pdf)\b/i.test(t) && !/drop or select/i.test(t);
    }

    /** Recruiter-facing name: First_Last.docx — reject archive resume_* / timestamp names. */
    function isCleanResumeUploadName(filename) {
        const fn = String(filename || '').trim();
        if (!fn) return false;
        if (/^resume_/i.test(fn)) return false;
        if (/^cover[_-]?letter_/i.test(fn)) return false;
        if (/_\d{10,}\./.test(fn)) return false; // timestamp suffix
        // First_Last.ext or First-Last.ext (1–3 name tokens)
        return /^[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z][A-Za-z0-9]*){0,2}\.(docx?|pdf)$/i.test(fn);
    }

    function sanitizeResumeNameToken(name, maxLen = 40) {
        let s = String(name || '').replace(/[^A-Za-z0-9]+/g, '_');
        s = s.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
        if (!s) return '';
        if (s.length > maxLen) s = s.substring(0, maxLen).replace(/_+$/g, '');
        return s;
    }

    /** Always First_Last.docx for ATS attach (never resume_…_Company_ts.docx). */
    function buildCleanResumeUploadName(profileOrNames, fallbackFilename = '', ext = '.docx') {
        const firstRaw = profileOrNames?.first_name
            ?? profileOrNames?.firstName
            ?? profileOrNames?.preferred_name
            ?? '';
        const lastRaw = profileOrNames?.last_name
            ?? profileOrNames?.lastName
            ?? '';
        let first = sanitizeResumeNameToken(firstRaw);
        let last = sanitizeResumeNameToken(lastRaw);
        if (!first || !last) {
            const fn = String(fallbackFilename || '').trim();
            // resume_First_Last_Company_ts.docx — tolerate spaces in tokens
            const m = fn.match(/^resume_([^_]+)_([^_]+)_/i)
                || fn.match(/^resume[_-]+(.+?)[_-]+(.+?)[_-]+/i);
            if (m) {
                first = first || sanitizeResumeNameToken(m[1]) || 'Candidate';
                last = last || sanitizeResumeNameToken(m[2]);
            }
        }
        if (!first) first = 'Candidate';
        const safeExt = (() => {
            const fromFb = String(fallbackFilename || '').match(/\.(docx?|pdf)$/i);
            if (fromFb) return fromFb[0].toLowerCase();
            return String(ext || '.docx').startsWith('.') ? String(ext) : `.${ext}`;
        })();
        return last ? `${first}_${last}${safeExt}` : `${first}${safeExt}`;
    }

    /** Force any resume payload to a clean First_Last.docx File.name. */
    function withCleanResumeFilename(resume, profile = null) {
        if (!resume || !resume.base64) return resume;
        const clean = buildCleanResumeUploadName(
            profile || {},
            resume.filename || resume.archiveFilename || ''
        );
        if (!clean || !isCleanResumeUploadName(clean)) {
            return { ...resume, filename: 'Candidate.docx' };
        }
        return { ...resume, filename: clean };
    }

    function readResumeInputFilename(input) {
        try {
            if (input?.files?.[0]?.name) return String(input.files[0].name);
        } catch (_) { /* ignore */ }
        const wrap = dropzoneAncestor(input);
        const t = String(wrap?.innerText || '').replace(/\s+/g, ' ').trim();
        const m = t.match(/([A-Za-z0-9][A-Za-z0-9._-]{2,120}\.(docx?|pdf))\b/i);
        return m ? m[1] : '';
    }

    function inspectResumeSlot(form) {
        const inputs = listFileInputsForUpload().filter((i) => fileInputKind(i) !== 'cover_letter');
        let filename = '';
        let filled = false;
        for (const input of inputs) {
            if (!fileSlotLooksFilled(input)) continue;
            filled = true;
            filename = readResumeInputFilename(input) || filename;
            if (filename) break;
        }
        // Fallback: form collect metadata
        if (!filename && Array.isArray(form?.fileInputs)) {
            const row = form.fileInputs.find((f) => {
                const kind = String(f.kind || '');
                const label = String(f.label || '');
                if (/cover/i.test(kind) || /cover[\s_-]*letter/i.test(label)) return false;
                return /resume|cv|r[ée]sum/i.test(`${kind} ${label}`) || kind === 'resume';
            });
            if (row?.fileName || row?.filename) filename = String(row.fileName || row.filename);
            if (row?.filled || row?.hasFile) filled = true;
        }
        return {
            filled,
            filename,
            nameOk: filled && isCleanResumeUploadName(filename),
            resumeRequired: pageHasRequiredResumeSlot(form)
        };
    }

    function requiredResumeFilled() {
        return listFileInputsForUpload().some((i) => (
            fileInputKind(i) !== 'cover_letter' && fileSlotLooksFilled(i)
        ));
    }

    function pageHasRequiredResumeSlot(form) {
        const fromCollect = (form?.fileInputs || []).some((f) => {
            const kind = String(f.kind || '');
            const label = String(f.label || '');
            if (/cover/i.test(kind) || /cover[\s_-]*letter/i.test(label)) return false;
            return !!f.required || /resume|cv|r[ée]sum/i.test(`${kind} ${label}`);
        });
        if (fromCollect) return true;
        if (listFileInputsForUpload().some((i) => {
            const kind = fileInputKind(i);
            const label = nearbyUploadLabel(i);
            return kind === 'resume' && (
                i.required
                || i.getAttribute('aria-required') === 'true'
                || /\*/.test(label)
            );
        })) return true;
        const body = String(document.body?.innerText || '').slice(0, 12000);
        return /\br[ée]sum[eé]\s*\*/i.test(body)
            && /drop or select|\.doc\s*\/\s*\.docx|accept.*\.(pdf|docx)/i.test(body);
    }

    function pageHasVisibleRequiredErrors() {
        const nodes = document.querySelectorAll(
            '[class*="error"], [role="alert"], [class*="invalid"], [class*="helper-text"], '
            + '[class*="FieldError"], [data-testid*="error"], p, span, small'
        );
        let n = 0;
        for (const el of nodes) {
            if (++n > 250) break;
            const t = String(el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!t || t.length > 90) continue;
            if (!/this field is required|^required$|is required\.?$/i.test(t)) continue;
            const st = window.getComputedStyle(el);
            if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) continue;
            if (el.getClientRects().length === 0) continue;
            return true;
        }
        return false;
    }

    function evaluateSubmitReadiness(form, fillStats = {}, uploadStats = {}) {
        const missing = [...(fillStats.missingRequired || [])];
        const resumeRequired = pageHasRequiredResumeSlot(form);
        const slot = inspectResumeSlot(form);
        const resumeOk = Number(uploadStats.uploadedResume || 0) > 0 || slot.filled || requiredResumeFilled();
        const expectedName = String(
            uploadStats.expectedResumeName
            || fillStats.expectedResumeName
            || ''
        ).trim();
        const nameOk = !resumeOk
            ? false
            : !!slot.nameOk;
        if (resumeRequired && !resumeOk && !missing.some((m) => /r[ée]sum|cv\b/i.test(String(m)))) {
            missing.push('Résumé');
        }
        if (resumeRequired && resumeOk && !nameOk
            && !missing.some((m) => /resume name|cv name/i.test(String(m)))) {
            missing.push('CV name');
        }
        const visibleRequiredErrors = pageHasVisibleRequiredErrors();
        const fileRequiredCount = (form?.fileInputs || []).filter((f) => (
            f.required && !/cover/i.test(String(f.kind || ''))
        )).length;
        const requiredTotal = Math.max(
            Number(fillStats.requiredTotal || 0),
            fileRequiredCount,
            resumeRequired ? 1 : 0
        );
        const fieldsComplete = Number(fillStats.requiredTotal || 0) > 0
            ? Number(fillStats.requiredOk || 0) === Number(fillStats.requiredTotal || 0)
                && !(fillStats.missingRequired || []).length
            : fillStats.requiredComplete !== false;
        const requiredComplete = fieldsComplete
            && !(resumeRequired && !resumeOk)
            && !(resumeRequired && resumeOk && !nameOk)
            && !visibleRequiredErrors;
        return {
            ok: requiredComplete,
            reason: resumeRequired && !resumeOk
                ? 'resume_required'
                : (resumeRequired && resumeOk && !nameOk
                    ? 'resume_name_invalid'
                    : (visibleRequiredErrors
                        ? 'visible_required_errors'
                        : (requiredComplete ? 'ok' : 'required_incomplete'))),
            missingRequired: missing,
            requiredComplete,
            requiredOk: requiredComplete
                ? requiredTotal
                : Math.max(0, requiredTotal - missing.length),
            requiredTotal,
            resumeRequired,
            resumeOk,
            resumeFilename: slot.filename || uploadStats.resumeFilename || '',
            resumeNameOk: nameOk,
            visibleRequiredErrors
        };
    }

    /**
     * Always verify CV before submit: file present + clean First_Last name.
     * Re-uploads from payload when missing or when archive name (resume_*) is on the input.
     */
    async function ensureResumeReadyBeforeSubmit(form, payload = {}, uploadStats = {}) {
        const profile = payload.profile || null;
        const rawResume = payload.resume || (
            payload.base64 && payload.filename
                ? { filename: payload.filename, base64: payload.base64, mimeType: payload.mimeType }
                : null
        );
        const resume = withCleanResumeFilename(rawResume, profile);
        const expectedName = String(
            resume?.filename
            || payload.expectedResumeName
            || uploadStats.expectedResumeName
            || ''
        ).trim();
        let stats = {
            ...uploadStats,
            expectedResumeName: expectedName || uploadStats.expectedResumeName || '',
            resumeFilename: expectedName || uploadStats.resumeFilename || ''
        };
        let slot = inspectResumeSlot(form);
        const needsFile = pageHasRequiredResumeSlot(form) || !!resume?.base64;
        if (!needsFile) {
            return {
                uploadStats: stats,
                slot,
                ok: true,
                reason: 'resume_not_required'
            };
        }

        const nameBad = !slot.filled || !isCleanResumeUploadName(slot.filename);
        const shouldReupload = !!resume?.base64 && (
            !slot.filled
            || nameBad
            || (expectedName && slot.filename && slot.filename !== expectedName)
        );

        if (shouldReupload) {
            // Clear messy file first when present so Greenhouse shows the new name.
            if (slot.filled && nameBad) {
                try {
                    for (const input of listFileInputsForUpload()) {
                        if (fileInputKind(input) === 'cover_letter') continue;
                        const wrap = dropzoneAncestor(input);
                        const clearBtn = wrap?.querySelector?.(
                            'button[aria-label*="remove" i], button[aria-label*="delete" i], '
                            + 'button[aria-label*="clear" i], [data-testid*="remove"], .remove-file, a[href="#"]'
                        );
                        // Prefer visible "X" near filename
                        const xBtn = [...(wrap?.querySelectorAll?.('button, a, span[role="button"]') || [])]
                            .find((el) => {
                                const t = String(el.textContent || '').trim();
                                const al = String(el.getAttribute('aria-label') || '');
                                return t === '×' || t === 'X' || t === 'x' || /remove|delete|clear/i.test(al);
                            });
                        (xBtn || clearBtn)?.click?.();
                    }
                    await new Promise((r) => setTimeout(r, 200));
                } catch (_) { /* ignore */ }
            }
            const cleaned = withCleanResumeFilename({
                ...resume,
                filename: expectedName || resume.filename
            }, profile);
            const re = await uploadApplicationFiles({
                ...payload,
                profile,
                resume: cleaned,
                filename: cleaned.filename,
                base64: cleaned.base64,
                mimeType: cleaned.mimeType,
                skipCoverLetter: true
            });
            stats = {
                ...stats,
                ...re,
                uploadedResume: Math.max(
                    Number(stats.uploadedResume || 0),
                    Number(re.uploadedResume || 0)
                ),
                uploaded: Number(stats.uploaded || 0) + Number(re.uploaded || 0),
                resumeFilename: cleaned.filename,
                expectedResumeName: cleaned.filename,
                resumeReuploaded: true
            };
            await new Promise((r) => setTimeout(r, 350));
            slot = inspectResumeSlot(form);
        }

        const filled = slot.filled || Number(stats.uploadedResume || 0) > 0;
        // DOM name must be clean — never trust intended name alone.
        const nameOk = filled && isCleanResumeUploadName(slot.filename);
        return {
            uploadStats: {
                ...stats,
                resumeFilename: slot.filename || stats.resumeFilename || '',
                resumeNameOk: nameOk
            },
            slot,
            ok: filled && nameOk,
            reason: !filled
                ? 'resume_required'
                : (nameOk ? 'ok' : 'resume_name_invalid')
        };
    }

    async function uploadBlobToInput(input, { filename, base64, mimeType }) {
        if (!base64 || !filename || !input) return false;
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], {
            type: mimeType || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        });
        const file = new File([blob], filename, { type: blob.type });
        try {
            const dt = new DataTransfer();
            dt.items.add(file);
            input.files = dt.files;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            try {
                const zone = dropzoneAncestor(input);
                if (zone && zone !== input) {
                    zone.dispatchEvent(new Event('change', { bubbles: true }));
                }
            } catch (_) { /* ignore */ }
            return true;
        } catch (err) {
            console.warn('[autofill] upload failed', err);
            return false;
        }
    }

    /**
     * Upload resume and/or cover letter to the correct file inputs.
     * Never puts a resume into a cover-letter slot. Skip CL when skipCoverLetter
     * or when the payload has no real cover_letter_* file.
     */
    async function uploadApplicationFiles(payload = {}) {
        const profile = payload.profile || null;
        const resume = withCleanResumeFilename(
            payload.resume || (
                payload.base64 && payload.filename
                    ? { filename: payload.filename, base64: payload.base64, mimeType: payload.mimeType }
                    : null
            ),
            profile
        );
        let coverLetter = payload.coverLetter || payload.cover_letter || null;
        const skipCoverLetter = !!payload.skipCoverLetter;

        // Hard gate: never put a resume into a cover-letter slot.
        // Refuse archive resume_* names and clean First_Last.docx without a cover marker.
        if (coverLetter?.filename) {
            const fn = String(coverLetter.filename);
            const looksLikeResumeArchive = /^resume_/i.test(fn);
            const looksLikeCover = /cover/i.test(fn);
            if (looksLikeResumeArchive || !looksLikeCover) {
                console.warn('[autofill] refusing resume-like file for cover letter slot', fn);
                coverLetter = null;
            }
        }
        if (skipCoverLetter) coverLetter = null;

        let uploaded = 0;
        let uploadedResume = 0;
        let uploadedCoverLetter = 0;
        let skippedCoverLetter = 0;

        const inputs = listFileInputsForUpload();
        for (const input of inputs) {
            const kind = fileInputKind(input);
            if (kind === 'cover_letter') {
                if (coverLetter?.base64 && coverLetter?.filename) {
                    if (await uploadBlobToInput(input, coverLetter)) {
                        uploaded += 1;
                        uploadedCoverLetter += 1;
                    }
                } else {
                    skippedCoverLetter += 1;
                }
                continue;
            }
            if (kind === 'resume') {
                if (resume?.base64 && resume?.filename) {
                    if (await uploadBlobToInput(input, resume)) {
                        uploaded += 1;
                        uploadedResume += 1;
                    }
                }
                continue;
            }
            // Ambiguous file inputs: leave for dual-slot logic below.
            if (kind === 'other') {
                continue;
            }
        }

        // Two unlabeled file slots (common Greenhouse layout): resume first, cover second.
        // Never dump the resume into slot 2 — leave CL empty when we have no real CL file.
        const others = inputs.filter((input) => fileInputKind(input) === 'other');
        if (others.length === 2) {
            if (resume?.base64 && resume?.filename && !uploadedResume) {
                if (await uploadBlobToInput(others[0], resume)) {
                    uploaded += 1;
                    uploadedResume += 1;
                }
            }
            if (coverLetter?.base64 && coverLetter?.filename && !uploadedCoverLetter) {
                if (await uploadBlobToInput(others[1], coverLetter)) {
                    uploaded += 1;
                    uploadedCoverLetter += 1;
                }
            } else {
                skippedCoverLetter += 1;
            }
        } else if (others.length === 1 && resume?.base64 && resume?.filename && !uploadedResume) {
            if (await uploadBlobToInput(others[0], resume)) {
                uploaded += 1;
                uploadedResume += 1;
            }
        }

        return {
            uploaded,
            uploadedResume,
            uploadedCoverLetter,
            skippedCoverLetter,
            resumeFilename: resume?.filename || '',
            expectedResumeName: resume?.filename || ''
        };
    }

    /** @deprecated use uploadApplicationFiles — kept as alias for callers */
    async function uploadResume(payload) {
        return uploadApplicationFiles(payload);
    }

    function findSubmitButton() {
        const candidates = [
            ...document.querySelectorAll('button, input[type="submit"], a[role="button"]')
        ];

        const scored = candidates.map((el) => {
            if (!el) return { el, score: -1, text: '' };
            // Include disabled submit — Greenhouse often enables it a beat after fill.
            const st = window.getComputedStyle(el);
            if (st.display === 'none' || st.visibility === 'hidden' || el.closest('[hidden]')) {
                return { el, score: -1, text: '' };
            }
            const text = `${el.innerText || el.value || el.getAttribute('aria-label') || ''}`.toLowerCase().trim();
            let score = 0;
            if (/^submit$|submit application|submit your application|send application|apply now|apply for this job/.test(text)) score += 8;
            if (/submit application/.test(text)) score += 4;
            if (/submit|apply/.test(text)) score += 2;
            if (/submit|apply now|send application|submit application/.test(text)) score += 3;
            if (el.type === 'submit') score += 3;
            if (/withdraw|delete account|unsubscribe|cancel application/.test(text)) score -= 20;
            if (/^next$|^save$|^back$|^preview$/i.test(text)) score -= 4;
            if (/^continue$|^confirm$|^verify$/i.test(text)) score += 1;
            if (el.disabled || el.getAttribute('aria-disabled') === 'true') score -= 1;
            return { el, score, text };
        }).filter((x) => x.score > 0);

        scored.sort((a, b) => b.score - a.score);
        return scored[0]?.el || null;
    }

    function humanClick(el) {
        if (!el) return false;
        try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) { /* ignore */ }
        try {
            const opts = { bubbles: true, cancelable: true, view: window };
            el.dispatchEvent(new PointerEvent('pointerdown', opts));
            el.dispatchEvent(new MouseEvent('mousedown', opts));
            el.dispatchEvent(new PointerEvent('pointerup', opts));
            el.dispatchEvent(new MouseEvent('mouseup', opts));
            el.dispatchEvent(new MouseEvent('click', opts));
        } catch (_) {
            try { el.click(); } catch (__) { /* ignore */ }
        }
        return true;
    }

    async function clickSubmitAsync({ waitEnabledMs = 2800 } = {}) {
        const ats = detectAts();
        if (ats === 'linkedin') {
            return { clicked: false, reason: 'linkedin_blocked' };
        }
        let btn = findSubmitButton();
        if (!btn) return { clicked: false, reason: 'no_submit_button' };

        const start = Date.now();
        while (
            (btn.disabled || btn.getAttribute('aria-disabled') === 'true')
            && Date.now() - start < waitEnabledMs
        ) {
            await new Promise((r) => setTimeout(r, 200));
            btn = findSubmitButton() || btn;
        }
        if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
            try {
                btn.disabled = false;
                btn.removeAttribute('disabled');
                btn.setAttribute('aria-disabled', 'false');
            } catch (_) { /* ignore */ }
        }
        humanClick(btn);
        return {
            clicked: true,
            label: (btn.innerText || btn.value || '').trim().slice(0, 80)
        };
    }

    function clickSubmit() {
        const ats = detectAts();
        if (ats === 'linkedin') {
            return { clicked: false, reason: 'linkedin_blocked' };
        }
        const btn = findSubmitButton();
        if (!btn) return { clicked: false, reason: 'no_submit_button' };
        if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
            try {
                btn.disabled = false;
                btn.removeAttribute('disabled');
                btn.setAttribute('aria-disabled', 'false');
            } catch (_) { /* ignore */ }
        }
        humanClick(btn);
        return { clicked: true, label: (btn.innerText || btn.value || '').trim().slice(0, 80) };
    }

    // Keep in sync with extension/lib/jobClosedPage.js
    const JOB_CLOSED_BANNER_RE = /the job you are looking for is no longer (?:open|available)|sorry[,.]? this job is no longer (?:open|available)|this job(?: posting)? is no longer (?:open|available)|the page you are looking for doesn['’]?t exist|the page you are looking for does not exist|this job cannot be viewed at this time|has either been deleted or is no longer available for application/i;
    const JOB_CLOSED_HEADING_RE = /^(job not found|page not found|404|not found)$/i;
    const JOB_LISTING_ONLY_RE = /\b\d+\s+jobs?\s+found\b|\bcurrent openings\b/i;

    function collectJobClosedSignals() {
        const form = pageLooksLikeApplyForm();
        const fieldCount = Number(form?.count) || 0;
        const alertText = Array.from(document.querySelectorAll(
            '[role="alert"], .flash, .flash--error, .banner, .error, [class*="error-message"], [class*="Flash"]'
        )).map((el) => (el.innerText || '').trim()).filter(Boolean).join(' ');
        const headingText = Array.from(document.querySelectorAll('h1, h2'))
            .slice(0, 4)
            .map((el) => (el.innerText || '').trim())
            .filter(Boolean)
            .join('\n');
        let httpStatus = 0;
        try {
            const nav = performance.getEntriesByType('navigation')[0];
            if (nav && Number(nav.responseStatus) > 0) httpStatus = Number(nav.responseStatus);
        } catch (_) { /* ignore */ }
        return {
            formReady: !!(form?.ok || fieldCount >= 2),
            fieldCount,
            alertText,
            headingText,
            title: document.title || '',
            text: String(document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1200),
            url: location.href || '',
            httpStatus
        };
    }

    function detectJobClosedPage() {
        try {
            const s = collectJobClosedSignals();
            if (s.formReady) return { closed: false, reason: 'form_present', count: s.fieldCount };
            let host = '';
            let path = '';
            let ghError = false;
            let isLeverApi = false;
            let isLeverApply = false;
            let isAshby = false;
            let isWorkday = false;
            try {
                const u = new URL(s.url);
                host = (u.hostname || '').replace(/^www\./i, '');
                path = u.pathname || '';
                const err = u.searchParams.get('error');
                ghError = /greenhouse\.io$/i.test(host) && (err === 'true' || err === '1');
                isLeverApi = /(^|\.)api\.lever\.co$/i.test(host);
                isLeverApply = /(^|\.)lever\.co$/i.test(host) && !isLeverApi;
                isAshby = /ashbyhq\.com$/i.test(host);
                isWorkday = /myworkdayjobs\.com$/i.test(host) || /\.workday\./i.test(host);
            } catch (_) { /* ignore */ }
            if (isLeverApi) return { closed: false, reason: 'lever_api_ignored' };
            const listingOnly = JOB_LISTING_ONLY_RE.test(s.text)
                && !JOB_CLOSED_BANNER_RE.test(s.alertText)
                && !JOB_CLOSED_BANNER_RE.test(s.headingText)
                && !JOB_CLOSED_BANNER_RE.test(s.text)
                && !ghError;
            if (listingOnly) return { closed: false, reason: 'listing_page' };
            if (ghError) {
                return { closed: true, match: 'error=true', snippet: s.url.slice(0, 160), via: 'greenhouse_error_url' };
            }
            if (isLeverApply && (s.httpStatus === 404 || s.httpStatus === 410)) {
                return { closed: true, match: `HTTP ${s.httpStatus}`, snippet: s.url.slice(0, 160), via: 'lever_http' };
            }
            const blob = `${s.alertText} ${s.headingText} ${s.text}`.trim();
            const m = blob.match(JOB_CLOSED_BANNER_RE);
            if (m) {
                const idx = Math.max(0, (m.index || 0) - 24);
                return { closed: true, match: m[0], snippet: blob.slice(idx, idx + 160), via: 'banner' };
            }
            const headLine = String(s.headingText || s.title || '').split(/\n/)[0].trim();
            if (JOB_CLOSED_HEADING_RE.test(headLine) && (isAshby || isLeverApply || isWorkday)) {
                return { closed: true, match: headLine, snippet: headLine, via: 'heading' };
            }
            return { closed: false, host, path };
        } catch (err) {
            return { closed: false, error: err?.message || String(err) };
        }
    }

    function pageLooksLikeApplyForm() {
        try {
            const form = collectForm();
            if (form.blocked) return { ok: false, reason: form.reason, ats: form.ats };
            const n = (form.fields?.length || 0) + (form.fileInputs?.length || 0);
            return { ok: n >= 2, count: n, ats: form.ats, form };
        } catch (err) {
            return { ok: false, reason: err?.message || String(err), ats: detectAts() };
        }
    }

    function showToast(text, kind = 'info') {
        try {
            const id = '__lumi_autofill_toast';
            let el = document.getElementById(id);
            if (!el) {
                el = document.createElement('div');
                el.id = id;
                el.setAttribute('role', 'status');
                Object.assign(el.style, {
                    position: 'fixed',
                    zIndex: '2147483647',
                    top: '16px',
                    right: '16px',
                    maxWidth: '360px',
                    padding: '12px 14px',
                    borderRadius: '10px',
                    fontFamily: 'system-ui,Segoe UI,sans-serif',
                    fontSize: '13px',
                    lineHeight: '1.35',
                    boxShadow: '0 8px 24px rgba(0,0,0,.25)',
                    color: '#fff',
                    pointerEvents: 'none'
                });
                document.documentElement.appendChild(el);
            }
            el.style.background = kind === 'error'
                ? '#b91c1c'
                : kind === 'ok'
                    ? '#15803d'
                    : '#1d4ed8';
            el.textContent = String(text || '').slice(0, 280);
            clearTimeout(el.__hideTimer);
            el.__hideTimer = setTimeout(() => {
                try { el.remove(); } catch (_) { /* ignore */ }
            }, 6000);
        } catch (_) { /* ignore */ }
    }

    /** Brief highlight on a field after fill (Simplify / JobWizard feedback). */
    function highlightFilledControl(el) {
        if (!el || !el.getBoundingClientRect) return;
        try {
            const target = el.closest('.select__control, [class*="select__control"], label, .field, .application-question')
                || el;
            const prev = target.style.outline;
            const prevOff = target.style.outlineOffset;
            target.style.outline = '2px solid #22c55e';
            target.style.outlineOffset = '2px';
            setTimeout(() => {
                try {
                    target.style.outline = prev;
                    target.style.outlineOffset = prevOff;
                } catch (_) { /* ignore */ }
            }, 1200);
        } catch (_) { /* ignore */ }
    }

    function updateAutofillPanel( partial = {}) {
        const root = document.getElementById('__lumi_autofill_panel');
        if (!root || !root.__lumiApi) return;
        root.__lumiApi.update(partial);
    }

    function ensureActionBar() {
        if (!extensionContextValid()) return;
        try {
            ensureActionBarInner();
        } catch (err) {
            if (isExtensionContextError(err)) return;
            console.warn('[lumi] ensureActionBar', err?.message || err);
        }
    }

    /**
     * JobWizard / Simplify-style on-page Autofill panel.
     * Detect form → one-click Autofill this page → live progress → review (no forced submit).
     */
    function ensureActionBarInner() {
        // Remove legacy bottom bar if present
        try {
            document.getElementById('__job_apply_bidder_bar')?.remove();
        } catch (_) { /* ignore */ }

        const id = '__lumi_autofill_panel';
        if (document.getElementById(id)) {
            // Refresh counts only — never clobber an in-progress fill status with "Ready".
            try {
                const snap = pageLooksLikeApplyForm();
                if (snap?.ok) {
                    updateAutofillPanel({
                        ats: snap.ats,
                        fieldCount: snap.count
                    });
                }
            } catch (_) { /* ignore */ }
            return;
        }
        let snap;
        try {
            snap = pageLooksLikeApplyForm();
        } catch (_) {
            return;
        }
        if (!snap?.ok) return;
        if (!extensionContextValid()) return;

        const root = document.createElement('div');
        root.id = id;
        root.setAttribute('data-lumi', 'autofill-panel');
        Object.assign(root.style, {
            position: 'fixed',
            zIndex: '2147483646',
            top: '72px',
            right: '16px',
            width: '300px',
            maxHeight: 'min(70vh, 520px)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0',
            padding: '0',
            borderRadius: '14px',
            background: '#0b1220',
            border: '1px solid #1e293b',
            boxShadow: '0 16px 40px rgba(0,0,0,.4)',
            fontFamily: 'system-ui,Segoe UI,sans-serif',
            color: '#e2e8f0',
            overflow: 'hidden'
        });

        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 14px',
            background: 'linear-gradient(135deg,#1e3a5f 0%,#0f172a 100%)',
            borderBottom: '1px solid #1e293b',
            cursor: 'default'
        });
        const title = document.createElement('div');
        title.innerHTML = '<div style="font-weight:700;font-size:14px;letter-spacing:.02em">Lumi Autofill</div>'
            + `<div style="font-size:11px;color:#94a3b8;margin-top:2px" data-lumi-ats>${snap.ats || 'apply form'} · ${snap.count} fields</div>`;
        const minBtn = document.createElement('button');
        minBtn.type = 'button';
        minBtn.textContent = '–';
        minBtn.title = 'Minimize';
        Object.assign(minBtn.style, {
            width: '28px', height: '28px', borderRadius: '8px', border: '0',
            background: '#334155', color: '#fff', cursor: 'pointer', fontSize: '16px', lineHeight: '1'
        });
        header.appendChild(title);
        header.appendChild(minBtn);

        const body = document.createElement('div');
        Object.assign(body.style, {
            padding: '12px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            overflowY: 'auto',
            maxHeight: 'min(56vh, 420px)'
        });

        const progressWrap = document.createElement('div');
        Object.assign(progressWrap.style, {
            height: '6px', borderRadius: '99px', background: '#1e293b', overflow: 'hidden'
        });
        const progressBar = document.createElement('div');
        Object.assign(progressBar.style, {
            height: '100%', width: '0%', background: '#3b82f6', transition: 'width .25s ease'
        });
        progressWrap.appendChild(progressBar);

        const status = document.createElement('div');
        Object.assign(status.style, { fontSize: '12px', color: '#94a3b8', lineHeight: '1.4', minHeight: '32px' });
        status.textContent = 'Click “Autofill this page” to start — waiting here does nothing until you click (or Auto Bid fills for you).';

        const stats = document.createElement('div');
        Object.assign(stats.style, {
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gap: '6px',
            fontSize: '11px',
            color: '#cbd5e1'
        });
        const mkStat = (label, key) => {
            const d = document.createElement('div');
            Object.assign(d.style, {
                background: '#111827', borderRadius: '8px', padding: '8px 6px', textAlign: 'center'
            });
            d.innerHTML = `<div style="font-size:16px;font-weight:700;color:#f8fafc" data-lumi-stat="${key}">0</div>`
                + `<div style="color:#64748b;margin-top:2px">${label}</div>`;
            return d;
        };
        stats.appendChild(mkStat('Filled', 'filled'));
        stats.appendChild(mkStat('Files', 'files'));
        stats.appendChild(mkStat('Left', 'left'));

        const mkBtn = (label, primary, onClick) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = label;
            Object.assign(b.style, {
                padding: '11px 14px',
                borderRadius: '10px',
                border: '0',
                cursor: 'pointer',
                fontWeight: '650',
                fontSize: '13px',
                color: '#fff',
                background: primary ? '#2563eb' : '#334155',
                width: '100%',
                textAlign: 'center'
            });
            b.addEventListener('mouseenter', () => {
                if (!b.disabled) b.style.filter = 'brightness(1.08)';
            });
            b.addEventListener('mouseleave', () => { b.style.filter = ''; });
            b.addEventListener('click', onClick);
            return b;
        };

        const btnAutofill = mkBtn('Autofill this page', true, () => {
            api.setBusy(true, 'Autofilling profile…', 8);
            showToast('Lumi Autofill — filling from your profile…', 'info');
            safeRuntimeSend({ type: 'RUN_PROFILE_AUTOFILL' }, (res) => {
                if (!res?.ok) {
                    api.setBusy(false, res?.error || 'Autofill failed', 0);
                    showToast(res?.error || 'Autofill failed', 'error');
                    return;
                }
                const f = res.result || {};
                const filled = Number(f.filled || 0);
                const uploaded = Number(f.uploaded || 0);
                const left = Math.max(
                    Number(f.missingRequired?.length || 0),
                    Number(f.requiredTotal || 0) - Number(f.requiredOk || 0),
                    Number(f.questions || 0)
                );
                api.setBusy(false, filled || uploaded
                    ? `Filled ${filled} · uploaded ${uploaded}. Review, then Answer questions if needed.`
                    : 'No fields filled — check profile / login', filled || uploaded ? 100 : 0);
                api.setStats({ filled, files: uploaded, left });
                showToast(
                    `Autofilled ${filled}` + (left ? ` · ${left} required left` : ''),
                    (filled + uploaded) > 0 ? 'ok' : 'error'
                );
            });
        });

        const btnAnswers = mkBtn('Answer questions', false, () => {
            api.setBusy(true, 'Drafting AI answers…', 20);
            showToast('AI answering selected questions…', 'info');
            safeRuntimeSend({ type: 'RUN_ANSWER_QUESTIONS' }, (res) => {
                if (!res?.ok) {
                    api.setBusy(false, res?.error || 'Generate a CV first (Alt+Shift+G)', 0);
                    showToast(res?.error || 'Answer questions failed — generate a CV first', 'error');
                    return;
                }
                const f = res.result || {};
                const answers = Number(f.answers || f.filled || 0);
                api.setBusy(false, answers
                    ? `Filled ${answers} AI answer(s). Review before submit.`
                    : 'No AI answers — check Generate tab', answers ? 100 : 0);
                api.setStats({ filled: answers, files: Number(f.uploaded || 0), left: 0 });
                showToast(
                    answers ? `Filled ${answers} AI answer(s)` : 'No AI answers returned',
                    answers > 0 ? 'ok' : 'error'
                );
            });
        });

        const hint = document.createElement('div');
        Object.assign(hint.style, { fontSize: '10px', color: '#64748b', lineHeight: '1.35' });
        hint.textContent = 'You stay in control — Lumi fills; you submit. Like Simplify / JobWizard.';

        body.appendChild(progressWrap);
        body.appendChild(status);
        body.appendChild(stats);
        body.appendChild(btnAutofill);
        body.appendChild(btnAnswers);
        body.appendChild(hint);

        let minimized = false;
        minBtn.addEventListener('click', () => {
            minimized = !minimized;
            body.style.display = minimized ? 'none' : 'flex';
            minBtn.textContent = minimized ? '+' : '–';
            minBtn.title = minimized ? 'Expand' : 'Minimize';
        });

        root.appendChild(header);
        root.appendChild(body);
        document.documentElement.appendChild(root);

        const api = {
            setBusy(busy, text, pct) {
                btnAutofill.disabled = !!busy;
                btnAnswers.disabled = !!busy;
                btnAutofill.style.opacity = busy ? '0.65' : '1';
                btnAnswers.style.opacity = busy ? '0.65' : '1';
                if (text) status.textContent = text;
                if (pct != null) progressBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
                progressBar.style.background = busy ? '#3b82f6' : (pct >= 100 ? '#22c55e' : '#3b82f6');
            },
            setStats({ filled = 0, files = 0, left = 0 } = {}) {
                const set = (k, v) => {
                    const n = root.querySelector(`[data-lumi-stat="${k}"]`);
                    if (n) n.textContent = String(v);
                };
                set('filled', filled);
                set('files', files);
                set('left', left);
            },
            update({ ats, fieldCount, status: st, progress, filled, files, left } = {}) {
                const atsEl = root.querySelector('[data-lumi-ats]');
                if (atsEl && (ats || fieldCount != null)) {
                    atsEl.textContent = `${ats || snap.ats || 'apply form'} · ${fieldCount != null ? fieldCount : snap.count} fields`;
                }
                if (st) status.textContent = st;
                if (progress != null) progressBar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
                if (filled != null || files != null || left != null) {
                    api.setStats({
                        filled: filled != null ? filled : 0,
                        files: files != null ? files : 0,
                        left: left != null ? left : 0
                    });
                }
            }
        };
        root.__lumiApi = api;
    }

    // Fallback when Chrome does not deliver extension commands.
    document.addEventListener('keydown', (e) => {
        if (!extensionContextValid()) return;
        if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
        const k = String(e.key || '').toLowerCase();
        if (k !== 'f' && k !== 'g' && k !== 'q' && k !== 'j') return;
        e.preventDefault();
        e.stopPropagation();
        if (k === 'q') {
            showQuestionPicker();
            return;
        }
        if (k === 'j') {
            safeRuntimeSend({ type: 'START_JD_PICK_ACTIVE' }, () => {
                /* background starts pick on active tab */
            });
            showToast('JD pick mode — click the job description block', 'info');
            return;
        }
        if (k === 'f') {
            ensureActionBar();
            updateAutofillPanel({ status: 'Autofilling profile…', progress: 10 });
            showToast('Autofill — saved profile…', 'info');
            safeRuntimeSend({ type: 'RUN_PROFILE_AUTOFILL' }, (res) => {
                if (!res?.ok) {
                    showToast(res?.error || 'Autofill failed', 'error');
                    updateAutofillPanel({ status: res?.error || 'Autofill failed', progress: 0 });
                    return;
                }
                const f = res.result || {};
                updateAutofillPanel({
                    status: `Autofilled ${f.filled || 0} — review before submit`,
                    progress: 100,
                    filled: f.filled || 0,
                    files: f.uploaded || 0,
                    left: f.questions || 0
                });
                showToast(
                    `Autofilled ${f.filled || 0}`
                        + (f.questions ? ` · then Answer questions` : ''),
                    ((f.filled || 0) + (f.uploaded || 0)) > 0 ? 'ok' : 'error'
                );
            });
        } else {
            showToast('Lumi: generate started…', 'info');
            safeRuntimeSend({ type: 'RUN_BID_GENERATE', alsoFill: false }, (res) => {
                if (!res?.ok) showToast(res?.error || 'Generate failed', 'error');
                else showToast('Generate opened — watch the app tab', 'ok');
            });
        }
    }, true);

    try {
        if (extensionContextValid()) {
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => setTimeout(ensureActionBar, 1200));
            } else {
                setTimeout(ensureActionBar, 1200);
            }
            setTimeout(ensureActionBar, 3500);
        }
    } catch (_) { /* ignore */ }

    try {
        if (extensionContextValid()) {
            chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
                if (!extensionContextValid()) {
                    try {
                        sendResponse({ ok: false, error: 'Extension reloaded — refresh this tab' });
                    } catch (_) { /* ignore */ }
                    return false;
                }
                try {
                    return onFillRuntimeMessage(msg, sendResponse);
                } catch (err) {
                    if (isExtensionContextError(err)) return false;
                    try {
                        sendResponse({ ok: false, error: err?.message || String(err) });
                    } catch (_) { /* ignore */ }
                    return false;
                }
            });
        }
    } catch (_) { /* ignore */ }

    function onFillRuntimeMessage(msg, sendResponse) {
        if (msg?.type === 'SHOW_TOAST') {
            showToast(msg.text || '', msg.kind || 'info');
            sendResponse({ ok: true });
            return true;
        }
        if (msg?.type === 'SHOW_QUESTION_PICKER') {
            try {
                sendResponse(showQuestionPicker());
            } catch (err) {
                sendResponse({ ok: false, error: err?.message || String(err) });
            }
            return true;
        }
        if (msg?.type === 'SELECT_ALL_QUESTIONS') {
            try {
                sendResponse(selectAllQuestions());
            } catch (err) {
                sendResponse({ ok: false, error: err?.message || String(err) });
            }
            return true;
        }
        if (msg?.type === 'CLEAR_QUESTION_SELECTION') {
            clearQuestionSelections();
            closeQuestionPicker();
            sendResponse({ ok: true });
            return true;
        }
        if (msg?.type === 'UPDATE_AUTOFILL_PANEL') {
            try {
                ensureActionBar();
                updateAutofillPanel({
                    status: msg.status || undefined,
                    progress: msg.progress,
                    filled: msg.filled,
                    files: msg.files,
                    left: msg.left
                });
                sendResponse({ ok: true });
            } catch (err) {
                sendResponse({ ok: false, error: err?.message || String(err) });
            }
            return true;
        }
        if (msg?.type === 'COLLECT_FORM') {
            try {
                sendResponse({ ok: true, data: collectForm() });
            } catch (err) {
                sendResponse({ ok: false, error: err?.message || String(err) });
            }
            return true;
        }
        if (msg?.type === 'DETECT_APPLY_FORM') {
            try {
                sendResponse({ ok: true, data: pageLooksLikeApplyForm() });
            } catch (err) {
                sendResponse({ ok: false, error: err?.message || String(err) });
            }
            return true;
        }
        if (msg?.type === 'DETECT_JOB_CLOSED') {
            try {
                sendResponse({ ok: true, data: detectJobClosedPage() });
            } catch (err) {
                sendResponse({ ok: false, error: err?.message || String(err) });
            }
            return true;
        }
        if (msg?.type === 'FILL_FORM') {
            (async () => {
                try {
                    const form = collectForm();
                    const fieldCount = (form.fields?.length || 0) + (form.fileInputs?.length || 0);
                    const closed = fieldCount >= 2 ? { closed: false } : detectJobClosedPage();
                    if (closed?.closed) {
                        showToast('This job is no longer open', 'error');
                        updateAutofillPanel({ status: 'Job expired — bid stopped', progress: 100 });
                        sendResponse({
                            ok: false,
                            error: 'job_expired',
                            jobExpired: true,
                            snippet: closed.snippet || null
                        });
                        return;
                    }
                    if (form.blocked) {
                        showToast(form.reason || 'Site blocked', 'error');
                        sendResponse({ ok: false, error: form.reason, ats: form.ats });
                        return;
                    }

                    // Bidder warm-up: upload files only — do not apply profile defaults.
                    if (msg.payload?.uploadOnly) {
                        showToast('Uploading files…', 'info');
                        const uploadStats = await uploadApplicationFiles(msg.payload || {});
                        showToast(
                            `Uploaded ${uploadStats.uploaded || 0} file(s)`,
                            (uploadStats.uploaded || 0) > 0 ? 'ok' : 'error'
                        );
                        sendResponse({
                            ok: true,
                            ats: form.ats,
                            fillStats: { filled: 0 },
                            uploadStats,
                            submitStats: { clicked: false }
                        });
                        return;
                    }

                    showToast('Filling form fields…', 'info');
                    try { ensureActionBar(); } catch (_) { /* ignore */ }
                    updateAutofillPanel({ status: 'Autofilling…', progress: 5 });
                    // Always fill against a fresh collect — payload field ids go stale when
                    // React re-renders (react-select-* ids). Answers still match by label.
                    // Answers-only: prefer question/salary fields to avoid re-wiping profile selects.
                    let fields = form.fields;
                    if (msg.payload?.answersOnly && Array.isArray(msg.payload?.answers) && msg.payload.answers.length) {
                        const qIds = new Set(msg.payload.answers.map((a) => String(a.id)));
                        const qLabels = new Set(
                            msg.payload.answers
                                .map((a) => String(a.label || '').trim().toLowerCase())
                                .filter(Boolean)
                        );
                        fields = form.fields.filter((f) =>
                            f.kind === 'question'
                            || f.kind === 'salary'
                            || qIds.has(String(f.id))
                            || qLabels.has(String(f.label || '').trim().toLowerCase())
                        );
                        if (!fields.length) fields = form.fields;
                    }
                    const fillStats = await fillForm({
                        fields,
                        answers: msg.payload?.answers,
                        profile: msg.payload?.profile,
                        jobDescription: msg.payload?.jobDescription || '',
                        companyName: msg.payload?.companyName || msg.payload?.company_name || '',
                        jobRole: msg.payload?.jobRole || msg.payload?.job_role || '',
                        skipQuestions: !!(msg.payload?.skipQuestions || msg.payload?.profileOnly)
                    });
                    const uploadStats = await uploadApplicationFiles(msg.payload || {});
                    const resumeGate = await ensureResumeReadyBeforeSubmit(
                        form,
                        msg.payload || {},
                        {
                            ...uploadStats,
                            expectedResumeName: msg.payload?.resume?.filename
                                || msg.payload?.filename
                                || msg.payload?.expectedResumeName
                                || ''
                        }
                    );
                    const gatedUploadStats = resumeGate.uploadStats || uploadStats;
                    const readiness = evaluateSubmitReadiness(form, fillStats, gatedUploadStats);
                    const mergedFillStats = {
                        ...fillStats,
                        requiredComplete: readiness.requiredComplete,
                        requiredOk: readiness.requiredOk,
                        requiredTotal: readiness.requiredTotal,
                        missingRequired: readiness.missingRequired,
                        incomplete: !readiness.requiredComplete,
                        resumeRequired: readiness.resumeRequired,
                        resumeOk: readiness.resumeOk,
                        resumeFilename: readiness.resumeFilename,
                        resumeNameOk: readiness.resumeNameOk,
                        uploadedResume: gatedUploadStats.uploadedResume || 0,
                        uploaded: gatedUploadStats.uploaded || 0,
                        visibleRequiredErrors: readiness.visibleRequiredErrors
                    };
                    let submitStats = { clicked: false };
                    if (msg.payload?.autoSubmit) {
                        if (!readiness.ok || !resumeGate.ok) {
                            const reason = !resumeGate.ok ? resumeGate.reason : readiness.reason;
                            submitStats = {
                                clicked: false,
                                reason,
                                missing: readiness.missingRequired,
                                resumeFilename: readiness.resumeFilename || '',
                                resumeNameOk: !!readiness.resumeNameOk
                            };
                            const toastMsg = reason === 'resume_name_invalid'
                                ? `Submit blocked — CV name must be First_Last.docx (got ${readiness.resumeFilename || 'messy name'})`
                                : reason === 'resume_required'
                                    ? 'Submit blocked — CV missing'
                                    : `Submit blocked — ${readiness.missingRequired.slice(0, 3).join(', ') || 'required fields empty'}`;
                            showToast(toastMsg, 'error');
                        } else {
                            try {
                                submitStats = await clickSubmitAsync({ waitEnabledMs: 3000 });
                            } catch (_) {
                                submitStats = clickSubmit();
                            }
                        }
                    }
                    const n = (mergedFillStats.filled || 0) + (gatedUploadStats.uploaded || 0);
                    if (!(msg.payload?.autoSubmit && (!readiness.ok || !resumeGate.ok))) {
                        showToast(
                            `Filled ${mergedFillStats.filled || 0}, uploaded ${gatedUploadStats.uploaded || 0}`
                                + (readiness.resumeFilename ? ` · CV ${readiness.resumeFilename}` : ''),
                            n > 0 ? 'ok' : 'error'
                        );
                    }
                    sendResponse({
                        ok: true,
                        ats: form.ats,
                        engine: msg.payload?.engine || 'autofill-engine-v3',
                        fillStats: mergedFillStats,
                        uploadStats: gatedUploadStats,
                        submitStats,
                        resumeCheck: {
                            ok: resumeGate.ok,
                            reason: resumeGate.reason,
                            filename: readiness.resumeFilename || '',
                            nameOk: !!readiness.resumeNameOk
                        }
                    });
                } catch (err) {
                    if (isExtensionContextError(err)) {
                        try {
                            sendResponse({
                                ok: false,
                                error: 'Extension reloaded — refresh this tab'
                            });
                        } catch (_) { /* ignore */ }
                        return;
                    }
                    showToast(err?.message || 'Fill failed', 'error');
                    sendResponse({ ok: false, error: err?.message || String(err) });
                }
            })();
            return true;
        }
        if (msg?.type === 'CLICK_SUBMIT') {
            (async () => {
                try {
                    // Never force past empty required / sponsorship / visible errors.
                    // Instruct Lumi can pass instructForce to override.
                    const instructForce = !!msg.instructForce;
                    if (!instructForce) {
                        const form = collectForm();
                        const readiness = evaluateSubmitReadiness(form, {}, {
                            uploadedResume: requiredResumeFilled() ? 1 : 0
                        });
                        const emptySponsor = (form.fields || []).some((f) => {
                            if (f.kind !== 'requires_sponsorship' && !labelLooksLikeSponsorship(f.label || '')) {
                                return false;
                            }
                            const el = findElByField(f);
                            const got = readFieldCurrent(f, el);
                            return !got || !String(got).trim() || /^select(\.\.\.|…|:)?$/i.test(String(got).trim());
                        });
                        if (!readiness.ok || emptySponsor || readiness.visibleRequiredErrors) {
                            sendResponse({
                                ok: true,
                                clicked: false,
                                reason: emptySponsor
                                    ? 'sponsorship_empty'
                                    : (readiness.reason || 'required_incomplete'),
                                missing: readiness.missingRequired
                            });
                            return;
                        }
                    }
                    const result = await clickSubmitAsync({ waitEnabledMs: 3200 });
                    sendResponse({ ok: true, ...result });
                } catch (err) {
                    try {
                        sendResponse({ ok: true, ...(clickSubmit()) });
                    } catch (err2) {
                        sendResponse({ ok: false, error: err2?.message || err?.message || String(err) });
                    }
                }
            })();
            return true;
        }
        return false;
    }
})();
