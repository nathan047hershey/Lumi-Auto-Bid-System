/**
 * Lumi Bidder Engineer v1 — Greenhouse-first apply-form engine.
 * Independent of Autofill (content/fill.js). Do not use for Autofill hotkeys.
 *
 * Locked behavior:
 * - Greenhouse apply pages (multi-ATS uses fill.js via background)
 * - 100% required fields; 2 retries; dual strategies; verify before Next
 * - Max 6 multi-step pages; ~90s wall budget (matches BID_HARD_LIMIT_MS)
 * - Field-attempt logging via BIDDER_FIELD_ATTEMPTS
 * - Pre-submit: ready signal (background takes screenshot)
 */
(function () {
    if (window.__lumiBidderEngineV1) return;
    window.__lumiBidderEngineV1 = true;

    const ENGINE = 'bidder-engine-v1';
    const MAX_PAGES = 6;
    const MAX_RETRIES = 2;
    /** Fallback when payload.bidDeadline is missing — keep in sync with autofillEngine BID_HARD_LIMIT_MS. */
    const DEFAULT_BUDGET_MS = 90 * 1000;

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function detectAts() {
        const host = (location.hostname || '').toLowerCase();
        if (host.includes('greenhouse.io') || host.includes('boards.greenhouse')
            || host.includes('job-boards.greenhouse')) {
            return 'greenhouse';
        }
        if (host.includes('lever.co')) return 'lever';
        if (host.includes('ashbyhq') || host.includes('ashby')) return 'ashby';
        if (host.includes('myworkday') || host.includes('workday')) return 'workday';
        if (host.includes('oraclecloud.com') || /fa\.[a-z0-9]+\.oraclecloud/i.test(host)) return 'oracle';
        if (host.includes('icims.com')) return 'icims';
        if (host.includes('smartrecruiters.com')) return 'smartrecruiters';
        if (host.includes('bamboohr.com')) return 'bamboohr';
        if (document.querySelector('#greenhouse-job-application, [data-provider="Greenhouse"]')) {
            return 'greenhouse';
        }
        return 'unknown';
    }

    function visible(el) {
        if (!el || el.disabled) return false;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        const type = (el.type || '').toLowerCase();
        // Skip true aria-hidden trees (duplicate off-screen Greenhouse clones),
        // but keep opacity-0 radios/checkboxes Greenhouse uses for custom UI.
        if (el.closest('[hidden]')) return false;
        const ariaHidden = el.closest('[aria-hidden="true"]');
        if (ariaHidden && type !== 'radio' && type !== 'checkbox'
            && el.getAttribute('role') !== 'combobox') {
            return false;
        }
        // Greenhouse often hides native radios at opacity 0
        if (type === 'radio' || type === 'checkbox' || el.getAttribute('role') === 'combobox') {
            return el.getClientRects().length > 0 || !!el.offsetParent || st.opacity === '0';
        }
        if (Number(st.opacity) === 0) return false;
        return el.getClientRects().length > 0 || !!el.offsetParent;
    }

    function isPlaceholderLabelText(text) {
        const t = String(text || '').replace(/\s+/g, ' ').trim();
        if (!t) return true;
        if (/^select(\.\.\.|…|:)?$/i.test(t)) return true;
        if (/^choose(\s+one)?(\.\.\.|…|:)?$/i.test(t)) return true;
        if (/^type to search|^start typing|^search(\.\.\.|…)?$/i.test(t)) return true;
        return false;
    }

    function cleanLabelText(text) {
        const t = String(text || '').replace(/\s+/g, ' ').trim().split('\n')[0].trim();
        if (!t || t.length > 500) return '';
        const stripped = t
            .replace(/\s+Select(\.\.\.|…|:)?$/i, '')
            .replace(/\s+Choose(\s+one)?(\.\.\.|…|:)?$/i, '')
            .trim();
        if (isPlaceholderLabelText(stripped)) return '';
        return stripped;
    }

    function labelFor(el) {
        if (!el) return '';
        if (el.id) {
            const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            if (lab) {
                const t = cleanLabelText(lab.innerText || lab.textContent || '');
                if (t) return t.slice(0, 200);
            }
        }
        const aria = el.getAttribute('aria-label');
        if (aria && !isPlaceholderLabelText(aria)) {
            const t = cleanLabelText(aria);
            if (t) return t.slice(0, 200);
        }
        const labelled = el.getAttribute('aria-labelledby');
        if (labelled) {
            const text = labelled
                .split(/\s+/)
                .map((id) => document.getElementById(id))
                .filter(Boolean)
                .map((n) => (n.innerText || n.textContent || '').trim())
                .filter(Boolean)
                .join(' ');
            const t = cleanLabelText(text);
            if (t) return t.slice(0, 200);
        }
        const wrap = el.closest(
            'label, .field, .form-field, .application-field, [class*="field"], [class*="education"], .form-group'
        );
        if (wrap) {
            const clone = wrap.cloneNode(true);
            clone.querySelectorAll(
                'input, textarea, select, button, .select__placeholder, [class*="placeholder"], '
                + '.select__single-value, [class*="single-value"], [class*="menu"]'
            ).forEach((n) => n.remove());
            const t = cleanLabelText((clone.innerText || '').replace(/\s+/g, ' ').trim());
            if (t) return t.slice(0, 200);
        }
        // Previous sibling title (common Greenhouse education / essay layout).
        // Essay prompts are often 100–300 chars — the old <80 cap dropped them and
        // left required textareas empty while still reporting FILLED.
        let node = el.closest('.select__control, [class*="select__control"]') || el;
        let prev = node.parentElement?.previousElementSibling || node.previousElementSibling;
        const maxSibling = el.tagName === 'TEXTAREA' ? 420 : 140;
        for (let i = 0; i < 6 && prev; i++, prev = prev.previousElementSibling) {
            const t = cleanLabelText(prev.innerText || prev.textContent || '');
            if (t && t.length <= maxSibling) return t.slice(0, maxSibling);
        }
        // Parent field shell often holds the long question text above a textarea.
        if (el.tagName === 'TEXTAREA') {
            const shell = el.closest(
                '.field, .form-field, .application--question, [class*="question"], fieldset, .application-field'
            );
            if (shell) {
                try {
                    const clone = shell.cloneNode(true);
                    clone.querySelectorAll('input, textarea, select, button').forEach((n) => n.remove());
                    const t = cleanLabelText(clone.innerText || clone.textContent || '');
                    if (t && t.length >= 12 && t.length <= 420) return t.slice(0, 420);
                } catch (_) { /* ignore */ }
            }
        }
        return cleanLabelText(el.placeholder || el.name || '') || '';
    }

    function isRequired(el, label) {
        if (isLocationSubmitWaived(el, label)) return false;
        if (el.required || el.getAttribute('aria-required') === 'true') return true;
        if (el.closest('[required], .required, .is-required')) return true;
        if (/\*/.test(label) || /\brequired\b/i.test(label)) return true;
        const lab = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab && (lab.classList.contains('required') || /\*/.test(lab.textContent || ''))) return true;
        return false;
    }

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
            || (/without a location\b/.test(blob) && /unavailable|optional|not required|skip/.test(blob));
    }

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

    function classify(label, name = '') {
        const hay = `${label} ${name}`.toLowerCase();
        if (/\b(first[\s_-]*name|given[\s_-]*name)\b/.test(hay)) return 'first_name';
        if (/\b(last[\s_-]*name|family[\s_-]*name|surname)\b/.test(hay)) return 'last_name';
        if (/\b(full[\s_-]*name|your[\s_-]*name)\b/.test(hay) && !/first|last/.test(hay)) return 'full_name';
        if (/\bemail\b/.test(hay)) return 'email';
        if (/\b(phone|mobile|tel)\b/.test(hay)) return 'phone';
        if (/\blinkedin\b/.test(hay)) return 'linkedin';
        if (/\bgithub\b|\bportfolio\b/.test(hay)) return 'github';
        // Limited state list (PLOS / "operates in N states" / "which of the states…")
        if (
            /\bwhich of the states?\b/.test(hay)
            || /\bchoose which(?: of the)? states?\b/.test(hay)
            || /\boperates? in\b.{0,60}\bstates?\b/.test(hay)
            || (/\breside\b/.test(hay) && /\bstates?\b/.test(hay)
                && /\b(choose|select|which|operat|list of)\b/.test(hay))
        ) {
            return 'state';
        }
        // "Where are you located?" before US-resident help-text demotes it from city.
        if (
            /\bwhere (?:are|do) you (?:located|currently reside|live)\b/.test(hay)
            || /\bwhere are you located\b/.test(hay)
            || /\bcurrent[\s_-]*location\b/.test(hay)
            || /\bwhere do you currently reside\b/.test(hay)
        ) {
            if (
                /\bstates?\s+we\s+do\s+not\s+hire|\bdo not hire in\b|\bstates? we do not\b/.test(hay)
                || (/\b(alabama|alaska|hawaii|utah|nebraska)\b/.test(hay) && /\bhire\b/.test(hay))
            ) {
                return 'state';
            }
            return 'city';
        }
        // Yes/No "reside in the US / legally authorized" BEFORE city/location wording.
        // Exclude "Where do you currently reside?" (city) — that also contains "do you".
        if (
            (/\b(do you|are you)\b/.test(hay) && /\breside\b/.test(hay) && !/\bwhere\b/.test(hay))
            || (/\breside\b/.test(hay) && /\b(united states|u\.?\s*s\.?\s*a?\.?|u\.s\b)\b/.test(hay)
                && !/\bwhere\b/.test(hay))
            || /\blegal(?:ly)?\s+resid|\bpermanent\s+residenc/.test(hay)
        ) {
            return 'work_authorization';
        }
        // "Authorized to work … without sponsorship?" = work auth Yes — NOT need-sponsorship No.
        if (
            /\b(authorized|authorised|eligible)\b/.test(hay)
            && /\bwithout\s+(?:visa\s+)?sponsorship\b/.test(hay)
        ) {
            return 'work_authorization';
        }
        if (/\b(sponsor|sponsorship|visa|employment[\s_-]*visa|h-?1b|visa[\s_-]*status)\b/.test(hay)
            || /\bwill you.{0,60}\b(require|need).{0,40}\b(sponsor|visa)/.test(hay)) {
            return 'requires_sponsorship';
        }
        if (/\b(work[\s_-]*auth|authoriz)/.test(hay) && /\b(sponsor|visa|require)\b/.test(hay)) {
            return 'requires_sponsorship';
        }
        if (/\b(authoriz|eligible to work|work remotely|working from this state|legally[\s_-]*authorized)\b/.test(hay)) {
            return 'work_authorization';
        }
        if (/\bcountry\b/.test(hay) && !/\b(sponsor|visa|authoriz)\b/.test(hay)) return 'country';
        if (
            /\b(city|current[\s_-]*reside)\b/.test(hay)
            && !/\b(united states|u\.?\s*s\.?\s*a?\.?)\b/.test(hay)
        ) {
            return 'city';
        }
        if (/\b(state|province)\b/.test(hay) && !/\bworking from this state\b/.test(hay)) return 'state';
        if (/\bschool|university|college\b/.test(hay)) return 'school';
        if (/\bdegree\b/.test(hay) && !/highest/.test(hay)) return 'degree';
        if (/\bdiscipline|major|field of study\b/.test(hay)) return 'discipline';
        if (/\byears?\b/.test(hay) && /\bexperience\b/.test(hay)) return 'years_of_experience';
        if (/\bsalary|compensation|pay\b/.test(hay)) return 'salary';
        if (
            /\b(data[\s_-]*protection|privacy|gdpr|nda|non[\s_-]*disclosure|acknowledg|consent|ai[\s_-]*note|note[\s_-]*tak)\b/.test(hay)
            && !/\b(describe|explain)\b/.test(hay)
        ) {
            return 'data_protection';
        }
        if (/\b(data[\s_-]*protection|privacy[\s_-]*notice|privacy[\s_-]*policy|candidate[\s_-]*privacy|gdpr)\b/.test(hay)) {
            return 'data_protection';
        }
        if (/\bgender\b/.test(hay)) return 'gender';
        if (/\bover[\s_-]*18|18 or older\b/.test(hay)) return 'over_18';
        if (/\brelocat\w*\b/.test(hay)) return 'willing_to_relocate';
        // Office hub / hybrid onsite days → Yes
        if (/\bopen to working\b.{0,120}\b(office|hub|onsite|on[\s_-]*site)|\b\d+\s+days?\b.{0,60}\b(office|hub)|office hubs?\b/i.test(hay)) {
            return 'onsite_hub_yes';
        }
        // U.S. person (export control Yes/No) — before generic export_control citizen pick
        if (/\bU\.?\s*S\.?\s*person\b|whether you are a\s*["“']?U\.?\s*S\.?\s*person/i.test(hay)) {
            return 'us_person_yes';
        }
        if (/\b(have you (ever )?worked|previously\s+worked|former\b.{0,48}\bemployee|are you a former\b|employed by\b|ever been employed|have (?:you )?ever been employed|worked\s+(at|for)\b|ever\s+worked\s+(at|for)|permanent or temporary employee|(?:currently|previously)\s+(?:\([^)]*\)\s*)?working\s+for|working\s+for\b.{0,80}\b(contractor|contingent)|contractor or contingent|contingent worker|as an?\s+(employee|contractor|contingent)|employee or (?:a )?contractor|internal (?:candidate|employee)|applied (?:here|to (?:us|this)|before))\b/i.test(hay)) {
            return 'previous_employer_no';
        }
        if (/\b(disabilit(?:y|ies)|disabled|\bada\b)\b/.test(hay)) return 'disability_status';
        if (/\b(veteran|military[\s_-]*status|armed[\s_-]*forces)\b/.test(hay)) return 'veteran_status';
        if (/\b(race|ethnicity|ethnic)\b/.test(hay) && !/\bhispanic|latino\b/.test(hay)) return 'race_ethnicity';
        if (/\b(hispanic|latino|latina|latinx)\b/.test(hay)) return 'hispanic_latino';
        if (/\b(website|personal[\s_-]*site|homepage|web[\s_-]*site|portfolio)\b/.test(hay)
            && !/\blinkedin\b/.test(hay)
            && !/\bgithub\b/.test(hay)) {
            return 'website_url';
        }
        if (/\b(travel|willing[\s_-]*to[\s_-]*travel|percent[\s_-]*travel)\b/.test(hay)
            && !/\brelocat\w*\b/.test(hay)) {
            return 'willing_to_travel';
        }
        if (/\b(start[\s_-]*date|earliest[\s_-]*start|available[\s_-]*to[\s_-]*start|when[\s_-]*can[\s_-]*you[\s_-]*start)\b/.test(hay)
            && !/\b(birth|dob|signature|application\s*date|today)\b/.test(hay)) {
            return 'earliest_start_date';
        }
        if (/\b(notice[\s_-]*period|notice[\s_-]*time)\b/.test(hay)) return 'notice_period';
        if (/\b(how[\s_-]*did[\s_-]*you[\s_-]*(hear|find)|hear[\s_-]*about|find[\s_-]*this[\s_-]*(position|role|job)|referral[\s_-]*source|source[\s_-]*of[\s_-]*hire)\b/.test(hay)) {
            return 'how_heard';
        }
        if (/\b(how many companies|number of companies|companies have you worked)\b/.test(hay)) {
            return 'employer_count';
        }
        if (/\b(high[\s_-]*school)\b/.test(hay) && /\b(perform|performance|grade|mathematics|math|native language)\b/.test(hay)) {
            return 'high_school_performance';
        }
        if (/\b(rationale|evidence)\b/.test(hay)
            && /\b(high[\s_-]*school|performance|mathematics|native language|selections above)\b/.test(hay)) {
            return 'high_school_rationale';
        }
        if (/\b(bachelor.*degree result|degree result|grading system|expected result if you have not yet graduated)\b/.test(hay)) {
            return 'degree_result';
        }
        if (
            (
                /^(date|date\s*\*?)$/.test(hay.trim())
                || /\b(today'?s?\s*date|signature\s*date|date\s*signed|application\s*date)\b/.test(hay)
            )
            && !/\b(birth|dob|start|available|earliest)\b/.test(hay)
        ) {
            return 'todays_date';
        }
        if (/\b(why|describe|tell us|essay|cover letter|additional information|rationale|evidence)\b/.test(hay)) {
            return 'question';
        }
        return 'question';
    }

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
            return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
        }
    }

    function sponsorshipAnswerFromProfile(profile) {
        const raw = String(profile?.requires_sponsorship || '').trim();
        if (/^(yes|y|true|1)$/i.test(raw)) return 'Yes';
        return 'No';
    }

    function labelLooksLikeAuthorizedWithoutSponsorship(label) {
        const lab = String(label || '').toLowerCase();
        return /\b(authorized|authorised|eligible)\b/.test(lab)
            && /\bwithout\s+(?:visa\s+)?sponsorship\b/.test(lab);
    }

    function labelLooksLikeSponsorship(label) {
        if (labelLooksLikeAuthorizedWithoutSponsorship(label)) return false;
        const lab = String(label || '').toLowerCase();
        return /\b(sponsor|sponsorship|visa[\s_-]*sponsor|visa[\s_-]*support|require.*visa|need.*visa|need\s+visa\s+sponsorship|employment[\s_-]*visa|h-?1b|visa[\s_-]*status)\b/.test(lab)
            || /\b(now or in the future).{0,80}\b(sponsor|visa)/.test(lab)
            || /\bwill you.{0,80}\b(require|need).{0,60}\b(sponsor|visa)/.test(lab)
            || /\bneed\b.{0,40}\bvisa\b.{0,40}\bsponsor/.test(lab);
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

    /** Local essay when AI answers are missing / skipped (time budget). */
    function fallbackEssayForQuestion(label, profile, jobDescription = '') {
        const lab = String(label || '').toLowerCase();
        const p = profile || {};
        const skills = String(p.skills || p.technical_skills || '').trim();
        const yoe = String(p.years_of_experience || '').replace(/\D/g, '') || '';
        const jd = String(jobDescription || '').slice(0, 400);
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
        if (/\b(cloud|gcp|azure|kubernetes|k8s|docker|devops|infrastructure)\b/i.test(lab) && /\b(experience|proficient|describe|work(?:ed|ing)? with)\b/i.test(lab)) {
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
        if (jd && /\b(why|company|role|team)\b/i.test(lab)) {
            return 'I am interested in this role because it aligns with the production systems and stack on my resume.';
        }
        return '';
    }

    function lookupAnswer(answersById, answersByLabel, field) {
        const byId = answersById.get(String(field.id));
        if (byId) return String(byId).trim();
        const lab = String(field.label || '').trim().toLowerCase();
        if (lab) {
            const exact = answersByLabel.get(lab);
            if (exact) return String(exact).trim();
            // Fuzzy: AI label may truncate / differ slightly from DOM label.
            let best = '';
            let bestScore = 0;
            for (const [k, v] of answersByLabel.entries()) {
                if (!k || !v) continue;
                const a = k.length <= lab.length ? k : lab;
                const b = k.length <= lab.length ? lab : k;
                if (b.includes(a) && a.length >= 24) {
                    const score = a.length;
                    if (score > bestScore) {
                        bestScore = score;
                        best = String(v).trim();
                    }
                }
            }
            if (best) return best;
            // Keyword overlap for long essays (AWS / Glue / Lambda …)
            const keys = lab.split(/[^a-z0-9]+/).filter((w) => w.length > 3);
            for (const [k, v] of answersByLabel.entries()) {
                if (!v || k.length < 20) continue;
                const hits = keys.filter((w) => k.includes(w)).length;
                if (hits >= 3 && hits / Math.max(keys.length, 1) >= 0.35) {
                    return String(v).trim();
                }
            }
        }
        return '';
    }

    function normalizeWantedValue(raw, field, profile) {
        let v = String(raw || '').trim();
        const lab = String(field.label || '').toLowerCase();
        if (field.kind === 'employer_count' || /\bhow many companies\b|\bcompanies have you worked\b/.test(lab)) {
            const n = parseInt(v.replace(/[^\d]/g, ''), 10);
            if (!Number.isFinite(n) || n <= 0) {
                return String(countEmployersFromProfile(profile));
            }
            return String(n);
        }
        if (field.kind === 'high_school_performance' && !v) {
            return 'Above average';
        }
        if ((field.kind === 'high_school_rationale' || /rationale|evidence/.test(lab))
            && /^(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)$/i.test(v)) {
            const gpa = String(profile?.gpa || profile?.education_gpa || '').trim();
            if (gpa) {
                return `Strong grades in math and language; overall GPA around ${gpa.includes('/') ? gpa : `${gpa}/4.0`}.`;
            }
            return 'Above-average grades in mathematics and native language through high school.';
        }
        if (field.kind === 'degree_result' && (!v || /^(texas|california|florida|new york)$/i.test(v))) {
            const gpa = String(profile?.gpa || profile?.education_gpa || '').trim();
            if (gpa) return gpa.includes('/') ? gpa : `GPA ${gpa}/4.0`;
            const deg = String(profile?.degree || profile?.education_level || '').trim();
            if (/bachelor|master|phd/i.test(deg)) return `${deg} completed`;
            return 'no degree';
        }
        return v;
    }

    function fieldKey(el, label) {
        return String(el.id || el.name || label || `${el.tagName}_${el.type}`).slice(0, 140);
    }

    function collectFields() {
        const els = [...document.querySelectorAll('input, textarea, select')];
        const fields = [];
        for (const el of els) {
            if (!visible(el)) continue;
            const type = (el.type || '').toLowerCase();
            if (['hidden', 'submit', 'button', 'file', 'image'].includes(type)) continue;
            if (type === 'radio') continue; // handled as groups
            const label = labelFor(el);
            const kind = classify(label, el.name || '');
            if (type === 'checkbox') {
                const hay = `${label} ${el.name || ''}`.toLowerCase();
                const isConsent = /\b(agree|acknowledg|consent|terms|certify|confirm)\b/.test(hay);
                const keep = isConsent
                    || kind === 'requires_sponsorship'
                    || kind === 'work_authorization'
                    || kind === 'over_18'
                    || kind === 'willing_to_relocate'
                    || kind === 'previous_employer_no'
                    || kind === 'question';
                if (!keep) continue;
                fields.push({
                    id: fieldKey(el, label),
                    label,
                    kind: isConsent ? 'question' : kind,
                    name: el.name || '',
                    type: 'checkbox',
                    required: isRequired(el, label) || isConsent,
                    role: '',
                    value: el.checked ? 'Yes' : 'No'
                });
                continue;
            }
            fields.push({
                id: fieldKey(el, label),
                label,
                kind,
                name: el.name || '',
                type: el.tagName === 'TEXTAREA' ? 'textarea' : (type || el.tagName.toLowerCase()),
                required: isRequired(el, label),
                role: el.getAttribute('role') || '',
                value: el.value || ''
            });
        }
        // radio groups
        const radios = [...document.querySelectorAll('input[type="radio"]')].filter(visible);
        const byName = new Map();
        for (const r of radios) {
            const n = r.name || r.id;
            if (!byName.has(n)) byName.set(n, []);
            byName.get(n).push(r);
        }
        for (const [name, group] of byName) {
            const label = labelFor(group[0]) || name;
            fields.push({
                id: `radio_${name}`,
                label,
                kind: classify(label, name),
                name,
                type: 'radio',
                required: group.some((g) => isRequired(g, label)),
                options: group.map((g) => radioOptionText(g))
            });
        }
        return dedupeRequiredFields(fields);
    }

    /** Drop duplicate required clones (hidden + visible Greenhouse pairs). */
    function dedupeRequiredFields(fields) {
        const out = [];
        const seenKind = new Set();
        for (const f of fields) {
            if (!f.required) {
                out.push(f);
                continue;
            }
            const singleton = ['first_name', 'last_name', 'full_name', 'email', 'phone', 'linkedin', 'github'];
            if (singleton.includes(f.kind)) {
                if (seenKind.has(f.kind)) continue;
                seenKind.add(f.kind);
            }
            if (f.type === 'radio' && f.name) {
                const rk = `radio:${f.name}`;
                if (seenKind.has(rk)) continue;
                seenKind.add(rk);
            }
            out.push(f);
        }
        return out;
    }

    function fieldMissingLabel(f) {
        const lab = String(f?.label || '').replace(/\s+/g, ' ').trim();
        if (lab) return lab.slice(0, 120);
        if (f?.kind && f.kind !== 'question') return String(f.kind).replace(/_/g, ' ');
        if (f?.name) return String(f.name).slice(0, 80);
        return String(f?.id || 'required field').slice(0, 80);
    }

    function cm() {
        return window.__lumiControlMatch || null;
    }

    function radioOptionText(r) {
        const lab = r.closest('label');
        if (lab) {
            const c = lab.cloneNode(true);
            c.querySelectorAll('input').forEach((n) => n.remove());
            const t = (c.innerText || '').replace(/\s+/g, ' ').trim();
            if (t) return t.slice(0, 240);
        }
        const wrap = r.closest('[class*="radio"], [class*="answer"], [role="radio"]');
        if (wrap) {
            const c = wrap.cloneNode(true);
            c.querySelectorAll('input, button').forEach((n) => n.remove());
            const t = (c.innerText || '').replace(/\s+/g, ' ').trim();
            if (t && t.length < 240) return t;
        }
        return r.value || '';
    }

    function setNativeValue(el, value) {
        const proto = el.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc?.set) desc.set.call(el, value);
        else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function findEl(field) {
        if (field.type === 'radio') {
            return document.querySelector(`input[type="radio"][name="${CSS.escape(field.name)}"]`);
        }
        if (field.type === 'checkbox') {
            const all = [...document.querySelectorAll('input[type="checkbox"]')];
            return all.find((el) => {
                if (!visible(el)) return false;
                const label = labelFor(el);
                if (fieldKey(el, label) === field.id) return true;
                if (field.name && el.name === field.name) return true;
                if (field.label && label.toLowerCase() === field.label.toLowerCase()) return true;
                return false;
            }) || null;
        }
        const all = [...document.querySelectorAll('input, textarea, select')];
        return all.find((el) => {
            if (!visible(el)) return false;
            const type = (el.type || '').toLowerCase();
            if (type === 'checkbox' || type === 'radio') return false;
            const label = labelFor(el);
            if (fieldKey(el, label) === field.id) return true;
            if (field.name && el.name === field.name) return true;
            if (field.label && label.toLowerCase() === field.label.toLowerCase()) return true;
            return false;
        }) || null;
    }

    function phoneDigits(s) {
        let d = String(s || '').replace(/[^\d]/g, '');
        if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
        return d;
    }

    function isPlaceholderValue(got) {
        const g = String(got || '').replace(/\s+/g, ' ').trim();
        if (!g) return true;
        if (/^select(\.\.\.|…|:)?$/i.test(g)) return true;
        if (/^choose(\s|$|\.\.\.|…)/i.test(g)) return true;
        if (/^--/.test(g) || /^type to search/i.test(g) || /^start typing/i.test(g)) return true;
        return false;
    }

    /** Resolve kind from label when scrape misclassified contractor/prior-employer as question. */
    function effectiveFieldKind(field) {
        const kind = String(field?.kind || '');
        const lab = String(field?.label || '');
        if (labelLooksLikeAuthorizedWithoutSponsorship(lab) || kind === 'work_authorization') {
            return 'work_authorization';
        }
        if (kind === 'previous_employer_no' || kind === 'requires_sponsorship' || kind === 'sanctioned_countries_no'
            || kind === 'city' || kind === 'state') {
            return kind;
        }
        if (
            /\bwhere (?:are|do) you (?:located|currently reside|live)\b/i.test(lab)
            || /\bwhere are you located\b/i.test(lab)
            || /\bcurrent[\s_-]*location\b/i.test(lab)
        ) {
            if (
                /\bstates?\s+we\s+do\s+not\s+hire|\bdo not hire in\b/i.test(lab)
                || (/\b(alabama|alaska|hawaii|utah|nebraska)\b/i.test(lab) && /\bhire\b/i.test(lab))
            ) {
                return 'state';
            }
            return 'city';
        }
        if (/\b(have you (ever )?worked|previously\s+worked|worked\s+(at|for)\b|former\s+(employee|employer)|(?:currently|previously).{0,40}working\s+for|contractor or contingent|contingent worker)\b/i.test(lab)) {
            return 'previous_employer_no';
        }
        if (labelLooksLikeSponsorship(lab)) {
            return 'requires_sponsorship';
        }
        return kind || classifyKind(lab, field?.name || '', field?.id || '');
    }

    /**
     * Required gate: match wanted value, OR accept a real on-page value
     * (user finished the select) so Process can continue / submit.
     * Empty wanted + empty field is NOT satisfied — that falsely marked FILLED
     * when AI answers were missing for required essays.
     */
    function requiredFieldSatisfied(field, wanted, got) {
        const kind = effectiveFieldKind(field);
        const el = findEl(field);
        if (isLocationSubmitWaived(el, field?.label)
            || (/\blocation\b/i.test(String(field?.label || '')) && isLocationSubmitWaived(el, field?.label))) {
            return true;
        }
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
        if (w && valuesMatch(w, got, kind)) return true;
        if (isPlaceholderValue(got)) {
            // No answer generated and field still empty → incomplete (esp. essays).
            if (!w && (field?.type === 'textarea' || kind === 'question')) return false;
            return false;
        }
        if (kind === 'phone') return phoneDigits(got).length >= 7;
        if (kind === 'previous_employer_no' || kind === 'requires_sponsorship' || kind === 'sanctioned_countries_no') {
            if (/\bno\b/i.test(got) && !/yes/i.test(String(got).replace(/\bno\b/i, ''))) return true;
            if (w && valuesMatch(w, got, kind)) return true;
            return false;
        }
        // User or prior fill already put a real value in — don't block the queue
        if (!w) {
            const g = String(got || '').trim();
            if (field?.type === 'textarea' || kind === 'question') {
                return g.length >= 12;
            }
            return g.length > 0;
        }
        return false;
    }

    function readCurrentValue(field) {
        if (field.type === 'radio') {
            const checked = document.querySelector(`input[type="radio"][name="${CSS.escape(field.name)}"]:checked`);
            if (!checked) return '';
            return radioOptionText(checked);
        }
        if (field.type === 'checkbox') {
            const el = findEl(field);
            if (!el) return '';
            return el.checked ? 'Yes' : 'No';
        }
        const el = findEl(field);
        if (!el) return '';
        if (el.tagName === 'SELECT') {
            return el.options[el.selectedIndex]?.text || el.value || '';
        }
        // react-select: climb to shell — closest('div') is too shallow and misses .select__single-value
        const shell = el.closest(
            '.select-shell, .select__container, .select, [class*="select-shell"], '
            + '.select__control, [class*="select__control"]'
        ) || el.closest('[class*="Select"]') || el.parentElement;
        const single = shell?.querySelector?.(
            '.select__single-value, [class*="single-value"], [class*="singleValue"]'
        );
        if (single) {
            const t = (single.textContent || '').replace(/\s+/g, ' ').trim();
            if (t && !isPlaceholderValue(t)) return t;
        }
        if (shell?.querySelector?.('.select__value-container--has-value')) {
            const vc = shell.querySelector('.select__value-container--has-value');
            const t = (vc?.textContent || '').replace(/\s+/g, ' ').trim();
            const m = t.match(/^(Yes|No)\b/i);
            if (m) return m[1];
            if (t && !isPlaceholderValue(t) && t.length < 80) return t;
        }
        return el.value || '';
    }

    function valuesMatch(wanted, got, kind) {
        const helper = cm();
        const w = String(wanted || '').toLowerCase().replace(/\s+/g, ' ').trim();
        const g = String(got || '').toLowerCase().replace(/\s+/g, ' ').trim();
        if (!w) return true;
        if (!g) return false;
        if (g === w) return true;
        if (kind === 'phone') {
            const wd = phoneDigits(wanted);
            const gd = phoneDigits(got);
            if (wd && gd && (wd === gd || wd.endsWith(gd) || gd.endsWith(wd))) return true;
        }
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
        if (kind === 'email') {
            if (w === g) return true;
            if (w.split('@')[0] && g.includes(w)) return true;
        }
        if (helper) {
            if (helper.scoreChoice(wanted, got, '') >= 70) return true;
            if (helper.isAffirmative(wanted) && helper.isAffirmative(got) && !helper.hasNegation(got)) return true;
            if (helper.isNegative(wanted) && (helper.isNegative(got) || helper.hasNegation(got))) return true;
        }
        if (g.includes(w) || w.includes(g)) {
            if (helper?.isAffirmative(wanted) && helper.hasNegation(got)) return false;
            return true;
        }
        if (kind === 'degree' && /bachelor/.test(w) && /bachelor/.test(g)) return true;
        if (kind === 'degree' && /master/.test(w) && /master/.test(g)) return true;
        if (kind === 'discipline' && /computer/.test(w) && /computer|computing|\bcs\b/.test(g)) return true;
        if (kind === 'country' && /\+1\b/.test(g) && /united states|usa|\+1|us\b/i.test(w)) return true;
        if (/^select(\.\.\.|…|:)?$/i.test(g) || /^choose/i.test(g)) return false;
        if (kind === 'work_authorization' || kind === 'requires_sponsorship' || kind === 'over_18'
            || kind === 'willing_to_relocate' || kind === 'previous_employer_no' || kind === 'hispanic_latino'
            || kind === 'onsite_hub_yes' || kind === 'us_person_yes' || kind === 'disability_status') {
            if (kind === 'disability_status') {
                if (/^n/.test(w) && (/^n/.test(g) || /do not have|don'?t have|have not had|no disability/i.test(g))) return true;
                if (/^y/.test(g) && /have a disability/i.test(g) && !/do not|don'?t|have not had/i.test(g)) return false;
            }
            if (/^y/.test(w) && /^y/.test(g) && !/\bno\b/.test(g)) return true;
            if (/^n/.test(w) && (/^n/.test(g) || /\bno\b/.test(g))) return true;
        }
        if (kind === 'years_of_experience') {
            const wn = w.match(/(\d+)\s*\+?/);
            const gn = g.match(/(\d+)\s*\+?/);
            if (wn && gn && wn[1] === gn[1]) return true;
            if (wn && g.includes(wn[1])) return true;
        }
        if ((/^y/.test(w) || /agree|accept/.test(w)) && /^y/.test(g) && !/\bno\b/.test(g)) return true;
        if (/^n/.test(w) && /^n/.test(g)) return true;
        return false;
    }

    function listMenuOptions() {
        return [...document.querySelectorAll(
            '[role="option"], .select__option, [id*="react-select"][id*="-option-"], .select-option, '
            + '[class*="menu"] [class*="option"], [class*="listbox"] [class*="option"], .pac-item, li[role="option"]'
        )].filter((n) => {
            if (n.closest('[hidden], [aria-hidden="true"]')) return false;
            const st = window.getComputedStyle?.(n);
            if (st && (st.display === 'none' || st.visibility === 'hidden')) return false;
            if (n.getClientRects().length === 0 && n.offsetParent === null) return false;
            const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
            if (!t || /^no options$/i.test(t) || /^no results/i.test(t) || /^loading/i.test(t)) return false;
            if (/^type to search|^start typing|^search\.\.\./i.test(t)) return false;
            return true;
        });
    }

    function menuIsLoading() {
        const busy = document.querySelector(
            'input[aria-busy="true"], [role="combobox"][aria-busy="true"], '
            + '.select__control--is-loading, .select__loading-indicator, [class*="loading-indicator"]'
        );
        if (busy && busy.getClientRects().length) return true;
        const nodes = [...document.querySelectorAll(
            '[role="option"], .select__option, [class*="menu"] *, [class*="notice"], [class*="loading"]'
        )];
        for (const n of nodes) {
            if (n.getClientRects().length === 0 && n.offsetParent === null) continue;
            const t = String(n.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (/^loading|searching|please wait|fetching/.test(t)) return true;
        }
        return false;
    }

    async function waitForMenuOptions(timeoutMs = 8000) {
        const start = Date.now();
        let last = [];
        let sawLoading = false;
        while (Date.now() - start < timeoutMs) {
            const loading = menuIsLoading();
            if (loading) sawLoading = true;
            last = listMenuOptions();
            // Complete → stop waiting
            if (!loading && last.length > 0) {
                await sleep(50);
                const settled = listMenuOptions();
                if (settled.length > 0 && !menuIsLoading()) return settled;
            }
            // Incomplete empty with no spinner → bail early (type next)
            if (!loading && last.length === 0 && !sawLoading && Date.now() - start >= 600) {
                return last;
            }
            await sleep(120);
        }
        return last;
    }

    function isCatchAll(t) {
        return /somewhere\s*else|^other\b|not listed|none of the above|prefer not/i.test(String(t || ''));
    }

    async function fillCombobox(el, wanted, kind, strategy) {
        const helper = cm();
        const raw = String(wanted || '').trim();
        if (!raw || !el) return { ok: false, chosen: '', reason: 'empty' };

        const readDisplayed = () => {
            const root = el.closest('.select__control, [class*="select__control"], [class*="Select"]')
                || el.parentElement;
            const single = root?.querySelector?.('.select__single-value, [class*="single-value"], [class*="singleValue"]');
            const t = single ? (single.textContent || '').trim() : '';
            if (!t || /^select(\.\.\.|…|:)?$/i.test(t) || /^choose/i.test(t)) return '';
            return t;
        };

        // Already complete — never reopen / retype (stops Disability / EEO infinite loops).
        // Disability: if displayed Yes but we want No, force re-fill (do not trust prior wrong pick).
        const already = readDisplayed();
        if (kind === 'disability_status' || /disabilit/i.test(String(raw))) {
            const wantNoDis = /^(no)\b/i.test(raw)
                || /do not have a disability|don'?t have|no disability|have not had/i.test(raw);
            const shownYes = /^yes\b/i.test(already)
                && /disabilit|have had/i.test(already)
                && !/do not|don'?t|have not had/i.test(already);
            if (wantNoDis && shownYes) {
                // Clear the wrong Yes (Greenhouse react-select clear "x") then re-select No.
                try {
                    const root = el.closest('.select__control, [class*="select__control"], [class*="Select"]')
                        || el.parentElement;
                    const clearBtn = root?.querySelector?.(
                        '.select__clear-indicator, [class*="clear-indicator"], [aria-label*="clear" i]'
                    );
                    if (clearBtn) {
                        if (helper) helper.dispatchTrustedClick(clearBtn);
                        else clearBtn.click();
                        await sleep(80);
                    }
                } catch (_) { /* ignore */ }
            } else if (already && valuesMatch(raw, already, kind)) {
                return { ok: true, chosen: already, reason: 'already_complete' };
            } else if (already && helper && helper.scoreChoice(raw, already, '') >= 70) {
                return { ok: true, chosen: already, reason: 'already_complete' };
            }
        } else if (already && valuesMatch(raw, already, kind)) {
            return { ok: true, chosen: already, reason: 'already_complete' };
        } else if (already && helper && helper.scoreChoice(raw, already, '') >= 70) {
            return { ok: true, chosen: already, reason: 'already_complete' };
        }

        const scoreOpt = (t) => {
            let score = helper ? helper.scoreChoice(raw, t, '') : -1;
            // Never override a hard reject (-1) with substring boosts.
            if (score < 0) {
                if (kind === 'disability_status' || /disabilit/i.test(String(raw) + t)) {
                    const tl = t.toLowerCase();
                    const wantNoDis = /^(no)\b/i.test(raw)
                        || /do not have a disability|don'?t have|no disability|have not had/i.test(raw);
                    if (wantNoDis && /^yes\b/i.test(tl)) return -1;
                }
                return score;
            }
            const tl = t.toLowerCase();
            const w = raw.toLowerCase();
            if (tl === w) score = Math.max(score, 100);
            else if (tl.includes(w) || w.includes(tl)) {
                // Never let short "no"/"yes" substring-boost the opposite EEO option.
                const shortYn = /^(yes|no)$/i.test(w);
                const oppositeDis = /disabilit/i.test(tl)
                    && ((/^no$/i.test(w) && /^yes\b/i.test(tl)) || (/^yes$/i.test(w) && /^no\b/i.test(tl)));
                const disMismatch = /disabilit/i.test(w + tl)
                    && ((/do not have|don'?t have|^no\b|have not had/i.test(w) && /^yes\b/i.test(tl))
                        || (/^yes\b/i.test(w) && /^no\b|do not have|don'?t have/i.test(tl)));
                if (!(shortYn && oppositeDis) && !disMismatch) score = Math.max(score, 80);
            }
            if (kind === 'degree' && /bachelor/.test(w) && /bachelor/.test(tl)) score = Math.max(score, 88);
            if (kind === 'degree' && /master/.test(w) && /master/.test(tl)) score = Math.max(score, 88);
            if (kind === 'discipline') {
                if (/computer\s*science|\bcs\b/.test(w) && /computer\s*science|\bcs\b/.test(tl)) {
                    score = Math.max(score, 90);
                }
                if (/computer/.test(w) && /computer|computing/.test(tl) && !/business|biology/.test(tl)) {
                    score = Math.max(score, 78);
                }
            }
            // Disability / EEO — hard prefer No; reject Yes when want is No.
            if (/disabilit/i.test(tl) || /disabilit/i.test(w) || kind === 'disability_status') {
                const wantNoDis = /^(no)\b/i.test(w)
                    || /do not have a disability|don'?t have a disability|no disability|have not had/i.test(w);
                const optYesDis = /^yes\b/i.test(tl)
                    && /have a disability|have had one/i.test(tl)
                    && !/do not|don'?t|have not had/i.test(tl);
                const optNoDis = /^no\b/i.test(tl)
                    || /do not have|don'?t have|have not had one|no disability/i.test(tl);
                if (wantNoDis && optYesDis) score = -1;
                if (wantNoDis && optNoDis) score = Math.max(score, 99);
                if (/^(yes)\b/i.test(w) && !wantNoDis && optYesDis) score = Math.max(score, 96);
                if (/prefer not|do not want to answer|decline/i.test(w)
                    && /do not want to answer|prefer not|decline/i.test(tl)) {
                    score = Math.max(score, 95);
                }
            }
            if (/race|ethnicity|asian|white|black|hispanic|latino|native|pacific/i.test(kind + w + tl)) {
                if (tl.includes(w) || w.includes(tl)) score = Math.max(score, 88);
            }
            if (/high[\s_-]*school|mathematics|native language|above average|below average|high_school_performance/i.test(kind + w + tl)) {
                if (/above average|top\s*25|good|strong|\ba\b/i.test(w)
                    && /above average|top\s*(5|10|25)|excellent|strong|upper|\ba\b/i.test(tl)
                    && !/below|bottom|poor/i.test(tl)) {
                    score = Math.max(score, 88);
                }
                if (/above average|top\s*25/i.test(w) && /top\s*(5|10|25)\s*%/i.test(tl)) {
                    score = Math.max(score, 90);
                }
            }
            if (kind === 'years_of_experience') {
                const wn = (raw.match(/(\d+)\s*\+?/) || [])[1];
                if (wn && (tl.includes(wn) || new RegExp(`${wn}\\s*\\+?\\s*years?`, 'i').test(tl))) {
                    score = Math.max(score, 92);
                }
                if (/10\+|10\s*\+|more than 10|10 or more/i.test(w) && /10\+|10\s*\+|or more|more than/i.test(tl)) {
                    score = Math.max(score, 94);
                }
                if (/7\s*[-–]\s*10|7-10/i.test(w) && /7\s*[-–]\s*10|7-10/i.test(tl)) {
                    score = Math.max(score, 94);
                }
            }
            return score;
        };

        const control = el.closest('.select__control, [class*="select__control"]')
            || el.parentElement?.querySelector('.select__control')
            || el;
        const input = control.querySelector('input') || el;
        const yn = helper && (helper.isAffirmative(raw) || helper.isNegative(raw));
        const minScore = kind === 'discipline' || kind === 'high_school_performance' || kind === 'years_of_experience'
            ? 55
            : 70;

        // Open → TYPE FIRST (no long wait before input) → wait only if still incomplete
        if (helper) helper.dispatchTrustedClick(control);
        else control.click();
        await sleep(60);
        input.focus();

        let options = [];
        let best = null;
        let bestScore = -1;
        let catchAll = null;
        let pick = null;

        // Static Yes/No / EEO: brief peek only. Typeahead: skip pre-wait.
        if (yn || strategy === 'open' || /disabilit|veteran|gender|race|ethnicity|eeo/i.test(kind + raw)) {
            options = await waitForMenuOptions(yn ? 900 : 700);
            for (const o of options) {
                const t = (o.textContent || '').replace(/\s+/g, ' ').trim();
                if (isCatchAll(t)) {
                    catchAll = catchAll || o;
                    continue;
                }
                const score = scoreOpt(t);
                if (score > bestScore) {
                    bestScore = score;
                    best = o;
                }
            }
            pick = bestScore >= minScore ? best : null;
        }

        // Type immediately when not yet picked (Discipline / School / long lists)
        if (!pick && !yn) {
            try { setNativeValue(input, ''); } catch (_) { /* ignore */ }
            const filterLen = strategy === 'type' ? 48 : 16;
            for (const ch of raw.slice(0, filterLen)) {
                setNativeValue(input, (input.value || '') + ch);
                await sleep(35);
                if ((input.value || '').length >= 3 && menuIsLoading()) {
                    await waitForMenuOptions(2000);
                }
            }
            options = await waitForMenuOptions(5000);
            best = null;
            bestScore = -1;
            catchAll = null;
            for (const o of options) {
                const t = (o.textContent || '').replace(/\s+/g, ' ').trim();
                if (isCatchAll(t)) {
                    catchAll = catchAll || o;
                    continue;
                }
                const score = scoreOpt(t);
                if (score > bestScore) {
                    bestScore = score;
                    best = o;
                }
            }
            pick = bestScore >= minScore ? best : null;
            if (!pick && !(kind === 'discipline' || kind === 'degree' || kind === 'school')) {
                pick = catchAll || null;
            }
            if (!pick && (kind === 'discipline' || kind === 'degree') && strategy === 'type') {
                pick = catchAll || null;
            }
        }

        if (!pick) {
            // If display already looks right after open, leave it alone.
            const again = readDisplayed();
            if (again && (valuesMatch(raw, again, kind) || (helper && helper.scoreChoice(raw, again, '') >= 70))) {
                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                try { input.blur(); } catch (_) { /* ignore */ }
                return { ok: true, chosen: again, reason: 'display_ok_after_open' };
            }
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            // Do NOT clear a nearly-correct displayed value — that caused infinite re-select loops.
            return { ok: false, chosen: again || '', reason: options.length ? 'no_match' : 'options_still_loading_or_empty' };
        }
        if (helper) helper.dispatchTrustedClick(pick);
        else {
            pick.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
            pick.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            pick.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
            pick.click();
        }
        await sleep(180);
        // Commit: Tab / Enter so React-Select closes and locks the value.
        try {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
            await sleep(40);
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', keyCode: 9, bubbles: true }));
            input.blur();
        } catch (_) { /* ignore */ }
        await sleep(120);
        const chosen = (pick.textContent || '').trim();
        const displayed = readDisplayed();
        // Disability: verify displayed is No — never accept Yes after a No want.
        if (kind === 'disability_status' || /disabilit/i.test(String(raw))) {
            const wantNoDis = /^(no)\b/i.test(raw)
                || /do not have a disability|don'?t have|no disability|have not had/i.test(raw);
            const shownYes = /^yes\b/i.test(displayed || chosen)
                && /disabilit|have had/i.test(displayed || chosen)
                && !/do not|don'?t|have not had/i.test(displayed || chosen);
            if (wantNoDis && shownYes) {
                return { ok: false, chosen: displayed || chosen, reason: 'disability_still_yes' };
            }
            const shownNo = /^no\b/i.test(displayed || '')
                || /do not have|don'?t have|have not had|no disability/i.test(displayed || '');
            if (wantNoDis && shownNo) {
                return { ok: true, chosen: displayed || chosen };
            }
        }
        const ok = !!(displayed && valuesMatch(raw, displayed, kind))
            || (helper && displayed && helper.scoreChoice(raw, displayed, '') >= 70)
            || valuesMatch(raw, chosen, kind)
            || (helper && helper.scoreChoice(raw, chosen, '') >= 70);
        if (!ok) {
            // Keep whatever is displayed — clearing caused "choose again" loops.
            return { ok: false, chosen: displayed || chosen, reason: 'verify_failed' };
        }
        return { ok: true, chosen: displayed || chosen };
    }

    async function fillRadio(field, wanted, profile = null) {
        const helper = cm();
        const group = [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(field.name)}"]`)];
        let wantRaw = String(wanted || '').trim();
        const lab = String(field?.label || '');
        const kind = effectiveFieldKind(field) || field?.kind || '';
        // Never trust API/wanted Yes on these — profile or hard No only.
        if (labelLooksLikeAuthorizedWithoutSponsorship(lab) || kind === 'work_authorization') {
            const raw = String(profile?.work_authorization || '').trim();
            wantRaw = (/^(no|n)\b/i.test(raw) || /not authorized|unauthorized/i.test(raw)) ? 'No' : 'Yes';
        } else if (kind === 'requires_sponsorship' || labelLooksLikeSponsorship(lab)) {
            wantRaw = sponsorshipAnswerFromProfile(profile);
        } else if (
            kind === 'previous_employer_no'
            || kind === 'sanctioned_countries_no'
            || /\b(have you (ever )?worked|previously\s+worked|worked\s+(at|for)\b|former\s+(employee|employer)|(?:currently|previously).{0,40}working\s+for|contractor or contingent|contingent worker|permanent or temporary employee)\b/i.test(lab)
        ) {
            wantRaw = 'No';
        }
        const want = helper?.canonicalizeWant?.(wantRaw) || wantRaw;
        const wantYes = /^(yes|y)\b/i.test(want) || (helper && helper.isAffirmative(want) && !helper.isNegative(want));
        const wantNo = /^(no|n)\b/i.test(want) || (helper && helper.isNegative(want));
        let best = null;
        let bestScore = -1;
        let bestLen = 1e9;
        for (const r of group) {
            const t = radioOptionText(r);
            let score = helper
                ? helper.scoreChoice(want, t, r.value || '')
                : (t.toLowerCase() === want.toLowerCase() ? 100 : -1);
            const tClean = t.replace(/\s+/g, ' ').trim();
            // Prefer short exact Yes/No for fixed auth/sponsorship radios
            if (/^(yes|no)$/i.test(tClean)) {
                if (wantYes && /^yes$/i.test(tClean)) score = Math.max(score, 100);
                if (wantNo && /^no$/i.test(tClean)) score = Math.max(score, 100);
            }
            if (wantYes && helper?.hasNegation?.(tClean) && !/^yes\b/i.test(tClean)) {
                score = -1;
            }
            if (wantNo && /^(yes)\b/i.test(tClean) && !helper?.hasNegation?.(tClean)) {
                score = -1;
            }
            const len = tClean.length || 999;
            if (score > bestScore || (score === bestScore && score >= 65 && len < bestLen)) {
                bestScore = score;
                bestLen = len;
                best = r;
            }
        }
        if (!best || bestScore < 65) return { ok: false, chosen: '' };
        if (helper) helper.clickInputViaLabel(best);
        else best.click();
        best.checked = true;
        best.dispatchEvent(new Event('input', { bubbles: true }));
        best.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(80);
        const checked = document.querySelector(
            `input[type="radio"][name="${CSS.escape(field.name)}"]:checked`
        );
        if (!checked) return { ok: false, chosen: '' };
        const chosen = radioOptionText(checked);
        const ok = valuesMatch(want, chosen, field.kind)
            || (helper ? helper.scoreChoice(want, chosen, checked.value || '') >= 65 : false);
        return { ok, chosen };
    }

    async function fillSelect(el, wanted) {
        const helper = cm();
        const opts = [...el.options];
        const want = helper?.canonicalizeWant?.(wanted) || wanted;
        const aliases = (() => {
            const list = [String(want || '').trim(), String(wanted || '').trim()].filter(Boolean);
            const raw = String(wanted || '');
            // "Palo Alto, CA" → also try CA / California
            if (raw.includes(',')) {
                const tail = raw.split(',').pop().trim();
                if (tail) list.push(tail);
            }
            const stMap = {
                ca: 'California', ny: 'New York', tx: 'Texas', wa: 'Washington',
                fl: 'Florida', il: 'Illinois', ma: 'Massachusetts', or: 'Oregon',
                oh: 'Ohio', mi: 'Michigan', co: 'Colorado', az: 'Arizona',
                ga: 'Georgia', nc: 'North Carolina', pa: 'Pennsylvania', va: 'Virginia',
                nj: 'New Jersey', md: 'Maryland', tn: 'Tennessee', in: 'Indiana'
            };
            for (const a of [...list]) {
                const k = a.toLowerCase();
                if (stMap[k]) list.push(stMap[k], k.toUpperCase());
                const entry = Object.entries(stMap).find(([, v]) => v.toLowerCase() === k);
                if (entry) list.push(entry[0].toUpperCase(), entry[1]);
            }
            return [...new Set(list.filter(Boolean))];
        })();

        let match = null;
        for (const alias of aliases) {
            match = helper ? helper.matchNativeOption(opts, alias, 65) : null;
            if (match) break;
        }
        if (!match && /\b(acknowledg|data protection|privacy)\b/i.test(String(wanted || ''))) {
            match = helper ? helper.matchNativeOption(opts, 'I acknowledge', 65) : null;
        }
        if (!match) {
            let bestIdx = -1;
            let bestScore = -1;
            let bestLen = 1e9;
            for (let i = 0; i < opts.length; i++) {
                const raw = opts[i].text || opts[i].value || '';
                const val = String(opts[i].value || '').trim();
                if (helper?.isPlaceholderOption?.(raw, opts[i].value)) continue;
                const t = raw.toLowerCase();
                const v = val.toLowerCase();
                let score = -1;
                for (const alias of aliases) {
                    const w = alias.toLowerCase();
                    if (!w) continue;
                    if (t === w || v === w) score = Math.max(score, 100);
                    else if (w.length === 2 && v === w) score = Math.max(score, 98);
                    else if (/\backnowledg/.test(t) && /\backnowledg|agree|consent/.test(w)) score = Math.max(score, 92);
                    else if (w.length > 2 && (t.includes(w) || w.includes(t) || v.includes(w))) score = Math.max(score, 75);
                }
                const len = raw.length;
                if (score > bestScore || (score === bestScore && score >= 65 && len < bestLen)) {
                    bestScore = score;
                    bestLen = len;
                    bestIdx = i;
                }
            }
            if (bestIdx >= 0 && bestScore >= 65) match = opts[bestIdx];
        }
        if (!match) return { ok: false, chosen: '' };
        el.selectedIndex = [...el.options].indexOf(match);
        el.value = match.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, chosen: match.text };
    }

    async function fillCheckbox(field, wanted) {
        const helper = cm();
        const el = findEl(field);
        if (!el) return { ok: false, chosen: '' };
        const lab = String(field.label || '');
        const on = helper
            ? helper.wantCheckboxOn(wanted, lab)
            : /^(yes|y|true|1|agree|accept|on)$/i.test(String(wanted || '').trim());
        if (el.checked !== on) {
            if (helper) helper.clickInputViaLabel(el);
            else el.click();
            el.checked = on;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        await sleep(80);
        return { ok: el.checked === on, chosen: el.checked ? 'Yes' : 'No' };
    }

    async function fillOne(field, wanted, attempt, profile = null) {
        const strategy = attempt % 2 === 1 ? 'type' : 'open';
        if (field.type === 'radio') {
            return { ...(await fillRadio(field, wanted, profile)), strategy };
        }
        if (field.type === 'checkbox') {
            return { ...(await fillCheckbox(field, wanted)), strategy: 'checkbox' };
        }
        const el = findEl(field);
        if (!el) return { ok: false, chosen: '', strategy, error: 'el_not_found' };
        if (el.tagName === 'SELECT') {
            return { ...(await fillSelect(el, wanted)), strategy };
        }
        const isCombo = el.getAttribute('role') === 'combobox'
            || el.getAttribute('aria-autocomplete')
            || el.className?.toString?.().includes('select__');
        if (isCombo || field.role === 'combobox') {
            const kind = effectiveFieldKind(field) || field.kind || '';
            let res = await fillCombobox(el, wanted, kind, strategy);
            // Location select often lists US states — retry with state name if city string missed.
            if (!res?.ok && (kind === 'city' || kind === 'state')) {
                const st = String(wanted || '').split(',').pop()?.trim();
                if (st && st.toLowerCase() !== String(wanted || '').toLowerCase()) {
                    res = await fillCombobox(el, st, 'state', 'type');
                }
            }
            // Dropdown miss — type City, ST ZIP as free text (Evio-style manual entry).
            if (!res?.ok && (kind === 'city' || /\blocation\b/i.test(String(field?.label || '')))) {
                const freeText = formatLocationFreeText(profile, wanted);
                if (freeText) {
                    try {
                        setNativeValue(el, freeText);
                        await sleep(80);
                        const got = String(el.value || '').trim();
                        if (got.length >= 3) {
                            return { ok: true, chosen: got, strategy: 'location_free_text' };
                        }
                    } catch (_) { /* ignore */ }
                }
            }
            return { ...res, strategy };
        }
        setNativeValue(el, wanted);
        await sleep(60);
        return { ok: true, chosen: el.value, strategy: 'native' };
    }

    /**
     * Heuristic answer when profile/API left a required select empty.
     * Goal: ≥90% Greenhouse completion — never leave Select... on Yes/No.
     */
    function defaultAnswerForEmptySelect(field, profile, answersById, answersByLabel, jobDescription) {
        const fromProfile = profileValue(profile, answersById, answersByLabel, field, jobDescription);
        if (fromProfile && String(fromProfile).trim()) return String(fromProfile).trim();
        const lab = String(field.label || '');
        const kind = effectiveFieldKind(field) || field.kind || '';
        if (kind === 'disability_status' || /\bdisabilit/i.test(lab)) {
            return 'No, I do not have a disability';
        }
        if (kind === 'onsite_hub_yes' || /\bopen to working\b.{0,120}\b(office|hub|onsite)|office hubs?\b/i.test(lab)) {
            return 'Yes';
        }
        if (kind === 'us_person_yes' || /\bU\.?\s*S\.?\s*person\b/i.test(lab)) return 'Yes';
        if (kind === 'requires_sponsorship' || /\bsponsor|visa|h-?1b\b/i.test(lab)) return 'No';
        if (kind === 'previous_employer_no'
            || /\bformer\b.{0,48}\bemployee|employed by\b|ever been employed|worked\s+(at|for)\b/i.test(lab)) {
            return 'No';
        }
        if (kind === 'work_authorization' || /\bauthoriz|eligible to work\b/i.test(lab)) return 'Yes';
        if (kind === 'over_18' || /\bover[\s_-]*18|18 or older\b/i.test(lab)) return 'Yes';
        if (kind === 'hispanic_latino' || /\bhispanic|latino\b/i.test(lab)) return 'No';
        if (kind === 'veteran_status' || /\bveteran\b/i.test(lab)) {
            return 'I am not a protected veteran';
        }
        if (kind === 'gender' || /\bgender\b/i.test(lab)) return profile?.gender || 'Male';
        if (kind === 'state' || (/\bstate\b/i.test(lab) && /\b(reside|operat|which of)\b/i.test(lab))) {
            const st = String(profile?.state || '').trim();
            const map = {
                ca: 'California', ny: 'New York', tx: 'Texas', wa: 'Washington',
                fl: 'Florida', il: 'Illinois', ma: 'Massachusetts', or: 'Oregon',
                co: 'Colorado', az: 'Arizona', ga: 'Georgia', nc: 'North Carolina',
                pa: 'Pennsylvania', va: 'Virginia', nj: 'New Jersey', md: 'Maryland',
                oh: 'Ohio', mi: 'Michigan', mn: 'Minnesota', wi: 'Wisconsin'
            };
            return map[st.toLowerCase()] || st || '';
        }
        if (kind === 'how_heard' || /\bhear about|how did you\b/i.test(lab)) return 'LinkedIn';
        if (kind === 'willing_to_relocate' || /\brelocat/i.test(lab)) {
            return profile?.willing_to_relocate || 'No';
        }
        if (kind === 'data_protection' || /\b(acknowledg|consent|agree|privacy|nda)\b/i.test(lab)) {
            return 'I agree';
        }
        // Binary question shape with no mapped kind — safe polarity defaults.
        if (/\b(are|do|does|have|has|will|would|can|is)\b/i.test(lab) || /\?/.test(lab)) {
            if (/\b(open|willing|able|comfortable|agree|authorized|eligible|citizen|person)\b/i.test(lab)) {
                return 'Yes';
            }
            if (/\b(require|need|sponsor|convict|felony|disability|veteran|former|ever been|criminal)\b/i.test(lab)) {
                return 'No';
            }
            return 'No';
        }
        return '';
    }

    function isSelectLikeField(field) {
        if (!field) return false;
        if (field.type === 'select' || field.type === 'radio') return true;
        const el = findEl(field);
        if (!el) return false;
        if (el.tagName === 'SELECT') return true;
        return el.getAttribute('role') === 'combobox'
            || !!el.getAttribute('aria-autocomplete')
            || /select__/i.test(String(el.className || ''));
    }

    /**
     * Final reliability pass: fill empty required selects + force Disability = No.
     */
    async function sweepRequiredSelects(profile, answersById, answersByLabel, jobDescription) {
        let swept = 0;
        const fields = collectFields();
        // 1) Force Disability No even if previously wrong Yes.
        for (const f of fields) {
            const kind = effectiveFieldKind(f) || f.kind || '';
            const lab = String(f.label || '');
            if (kind !== 'disability_status' && !/\bdisabilit/i.test(lab)) continue;
            const got = readCurrentValue(f);
            const wrongYes = /^yes\b/i.test(got)
                && /disabilit|have had/i.test(got)
                && !/do not|don'?t|have not had/i.test(got);
            const empty = !got || isPlaceholderValue(got);
            if (wrongYes || empty) {
                const r = await fillOne(f, 'No, I do not have a disability', 2, profile);
                if (r?.ok) swept += 1;
                await sleep(120);
            }
        }
        // 1b) Force visa sponsorship → No when wrongly left on Yes.
        for (const f of fields) {
            const kind = effectiveFieldKind(f) || f.kind || '';
            const lab = String(f.label || '');
            if (labelLooksLikeAuthorizedWithoutSponsorship(lab)) continue;
            if (kind !== 'requires_sponsorship' && !labelLooksLikeSponsorship(lab)) continue;
            const want = sponsorshipAnswerFromProfile(profile);
            const got = readCurrentValue(f);
            const empty = !got || isPlaceholderValue(got);
            const wrongYes = want === 'No' && /^yes\b/i.test(String(got || '').trim());
            if (wrongYes || empty) {
                const r = await fillOne(f, want, 2, profile);
                if (r?.ok) swept += 1;
                await sleep(120);
            }
        }
        // 2) Empty required select / radio → heuristic Yes/No (never leave Select...).
        const empties = fields.filter((f) => {
            if (!f.required) return false;
            if (!isSelectLikeField(f)) return false;
            const kind = effectiveFieldKind(f) || f.kind || '';
            const lab = String(f.label || '');
            if (kind === 'disability_status' || /\bdisabilit/i.test(lab)) return false;
            if (kind === 'requires_sponsorship' || labelLooksLikeSponsorship(lab)) return false;
            const got = readCurrentValue(f);
            return !got || isPlaceholderValue(got);
        });
        for (const f of empties) {
            const wanted = defaultAnswerForEmptySelect(
                f, profile, answersById, answersByLabel, jobDescription
            );
            if (!wanted) continue;
            const r = await fillOne(f, wanted, 2, profile);
            if (r?.ok) swept += 1;
            await sleep(120);
        }
        return swept;
    }

    function profileValue(profile, answersById, answersByLabel, field, jobDescription) {
        const kind = effectiveFieldKind(field) || field.kind || '';
        const lab = String(field.label || '');
        // Absolute disability lock — before answers API / PROFILE_ONLY.
        if (kind === 'disability_status' || /\b(disabilit(?:y|ies)|disabled|\bada\b)\b/i.test(lab)) {
            return 'No, I do not have a disability';
        }
        // Hard locks — NEVER prefer API Yes for sponsorship / prior-employer / sanctioned.
        if (labelLooksLikeAuthorizedWithoutSponsorship(lab) || kind === 'work_authorization') {
            const raw = String(profile?.work_authorization || '').trim();
            if (/^(no|n)\b/i.test(raw) || /not authorized|unauthorized/i.test(raw)) return 'No';
            return 'Yes';
        }
        if (kind === 'requires_sponsorship' || labelLooksLikeSponsorship(lab)) {
            return sponsorshipAnswerFromProfile(profile);
        }
        if (kind === 'previous_employer_no'
            || kind === 'sanctioned_countries_no'
            || /\b(have you (ever )?worked|previously\s+worked|former\b.{0,48}\bemployee|are you a former\b|employed by\b|ever been employed|have (?:you )?ever been employed|worked\s+(at|for)\b|ever\s+worked\s+(at|for)|(?:currently|previously).{0,40}working\s+for|contractor or contingent|contingent worker|permanent or temporary employee)\b/i.test(lab)) {
            return 'No';
        }
        if (kind === 'onsite_hub_yes' || kind === 'us_person_yes'
            || /\bopen to working\b.{0,120}\b(office|hub|onsite|on[\s_-]*site)|office hubs?\b/i.test(lab)
            || /\bU\.?\s*S\.?\s*person\b/i.test(lab)) {
            return 'Yes';
        }
        const PROFILE_ONLY = new Set([
            'first_name', 'last_name', 'full_name', 'email', 'phone',
            'city', 'state', 'country', 'linkedin', 'github', 'todays_date',
            'disability_status', 'veteran_status', 'race_ethnicity',
            'hispanic_latino', 'gender',
            'how_heard', 'notice_period', 'earliest_start_date',
            'willing_to_travel', 'website_url', 'over_18', 'willing_to_relocate'
        ]);
        // Prefer answers API when present — except hard locks above.
        if (!PROFILE_ONLY.has(kind)) {
            const fromAnswers = lookupAnswer(answersById, answersByLabel, field);
            if (fromAnswers) return normalizeWantedValue(fromAnswers, field, profile);
        }
        const p = profile || {};
        const stateMap = {
            ca: 'California', ny: 'New York', tx: 'Texas', wa: 'Washington',
            fl: 'Florida', il: 'Illinois', ma: 'Massachusetts', or: 'Oregon',
            co: 'Colorado', az: 'Arizona', ga: 'Georgia', nc: 'North Carolina',
            pa: 'Pennsylvania', va: 'Virginia', nj: 'New Jersey', md: 'Maryland',
            oh: 'Ohio', mi: 'Michigan', mn: 'Minnesota', wi: 'Wisconsin',
            in: 'Indiana', tn: 'Tennessee', mo: 'Missouri', sc: 'South Carolina',
            ct: 'Connecticut', nv: 'Nevada', ok: 'Oklahoma', ky: 'Kentucky',
            al: 'Alabama', ak: 'Alaska', de: 'Delaware', hi: 'Hawaii', ia: 'Iowa',
            la: 'Louisiana', ms: 'Mississippi', ne: 'Nebraska', nm: 'New Mexico',
            ri: 'Rhode Island', sd: 'South Dakota', wv: 'West Virginia', ut: 'Utah',
            dc: 'District of Columbia'
        };
        const stRaw = String(p.state || '').trim();
        const stateFull = stateMap[stRaw.toLowerCase()] || stRaw;
        switch (kind) {
            case 'first_name': return p.first_name || '';
            case 'last_name': return p.last_name || '';
            case 'full_name': return `${p.first_name || ''} ${p.last_name || ''}`.trim();
            case 'email': return p.email || '';
            case 'phone': return p.phone || p.mobile || p.telephone || p.phone_number || '';
            case 'linkedin': return p.linkedin_url || '';
            case 'github': return p.github_url || p.portfolio_url || '';
            case 'state': return stateFull || stRaw;
            case 'city': {
                if (
                    /\bstates?\s+we\s+do\s+not\s+hire|\bdo not hire in\b/i.test(lab)
                    || (/\b(alabama|alaska|hawaii|utah)\b/i.test(lab) && /\bhire\b/i.test(lab))
                ) {
                    return stateFull || stRaw || p.city || '';
                }
                const city = p.city || '';
                if (city && stateFull && !/,/.test(city)) {
                    if (/^[A-Z]{2}$/i.test(stRaw)) return `${city}, ${stRaw.toUpperCase()}`;
                    return `${city}, ${stateFull}`;
                }
                return city || stateFull || '';
            }
            case 'country': return p.country || 'United States';
            case 'school': return p.school || '';
            case 'degree': return p.degree || p.education_level || '';
            case 'discipline': {
                let d = String(p.discipline || '').trim();
                if (!d && p.education) {
                    const m = String(p.education).match(/\bin\s+(.+?)\s+at\s+/i);
                    if (m) d = m[1].trim();
                }
                if (!d && /computer\s*science/i.test(`${p.education || ''} ${p.summary || ''}`)) {
                    d = 'Computer Science';
                }
                return d || 'Computer Science';
            }
            case 'years_of_experience': {
                const n = parseInt(String(p.years_of_experience || '').replace(/\D/g, ''), 10);
                if (n >= 10) return '10+ years';
                if (n >= 7) return '7-10 years';
                if (n >= 5) return '5-6 years';
                return p.years_of_experience || '';
            }
            case 'requires_sponsorship':
                return sponsorshipAnswerFromProfile(p);
            case 'todays_date':
                return formatEstTodayMdY();
            case 'work_authorization': {
                const raw = String(p.work_authorization || '').trim();
                if (/^(no|n)\b/i.test(raw) || /not authorized|unauthorized/i.test(raw)) return 'No';
                return 'Yes';
            }
            case 'over_18': return p.over_18 || 'Yes';
            case 'willing_to_relocate': return p.willing_to_relocate || 'Yes';
            case 'gender': return p.gender || '';
            case 'disability_status':
                // Hard lock: always No for every profile / ATS wording.
                return 'No, I do not have a disability';
            case 'onsite_hub_yes':
            case 'us_person_yes':
                return 'Yes';
            case 'veteran_status': return p.veteran_status || 'I am not a protected veteran';
            case 'race_ethnicity': return p.race_ethnicity || '';
            case 'hispanic_latino': return p.hispanic_latino || 'No';
            case 'how_heard': return p.how_heard || 'LinkedIn';
            case 'notice_period': return p.notice_period || '2 weeks';
            case 'earliest_start_date': return p.earliest_start_date || '2 weeks';
            case 'willing_to_travel': return p.willing_to_travel || 'Yes';
            case 'website_url':
                return p.website_url || p.portfolio_url || p.github_url || p.linkedin_url || '';
            case 'employer_count': return String(countEmployersFromProfile(p));
            case 'high_school_performance': return 'Above average';
            case 'high_school_rationale': {
                const gpa = String(p.gpa || p.education_gpa || '').trim();
                if (gpa) {
                    return `Strong grades in math and language; overall GPA around ${gpa.includes('/') ? gpa : `${gpa}/4.0`}.`;
                }
                return 'Above-average grades in mathematics and native language through high school.';
            }
            case 'degree_result': {
                const gpa = String(p.gpa || p.education_gpa || '').trim();
                if (gpa) return gpa.includes('/') ? gpa : `GPA ${gpa}/4.0`;
                const deg = String(p.degree || p.education_level || '').trim();
                if (/bachelor|master|phd/i.test(deg)) return `${deg} completed`;
                return 'no degree';
            }
            case 'previous_employer_no':
            case 'sanctioned_countries_no':
                return 'No';
            case 'salary': {
                const raw = String(p.salary_range || p.desired_salary || '').trim();
                return raw || '$120,000';
            }
            case 'data_protection': return 'Yes';
            case 'question': {
                const essay = fallbackEssayForQuestion(field.label, p, jobDescription);
                if (essay) return essay;
                return '';
            }
            default: {
                if (/\b(agree|acknowledg|consent|terms|certify|confirm|data[\s_-]*protection|privacy[\s_-]*notice|nda|non[\s_-]*disclosure|note[\s_-]*tak)\b/i.test(field.label || '')) {
                    return 'Yes';
                }
                const essay = fallbackEssayForQuestion(field.label, p, jobDescription);
                if (essay) return essay;
                // Required textareas with no AI answer — still write a short profile-based reply.
                if (field.type === 'textarea' || (field.required && String(field.label || '').length > 40)) {
                    const yoe = String(p.years_of_experience || '').replace(/\D/g, '');
                    const skills = String(p.skills || '').split(/[,;|]/).filter(Boolean).slice(0, 4).join(', ');
                    return (
                        `I have relevant production experience${yoe ? ` (${yoe}+ years)` : ''}`
                        + `${skills ? ` with ${skills}` : ''} described on my resume, `
                        + 'and I can apply that work directly to this role.'
                    );
                }
                return '';
            }
        }
    }

    function clickNext() {
        const buttons = [...document.querySelectorAll('button, a[role="button"], input[type="button"]')]
            .filter(visible);
        const scored = buttons.map((b) => {
            const t = (b.innerText || b.value || b.getAttribute('aria-label') || '').trim().toLowerCase();
            let score = 0;
            if (!t) return { b, score: -1, t };
            if (/^(next|continue|save and continue)$/i.test(t)) score += 12;
            else if (/\bnext\b/.test(t) || /\bcontinue\b/.test(t)) score += 6;
            if (/submit|apply|send application|withdraw|delete|back|cancel|previous|preview/.test(t)) {
                score -= 20;
            }
            return { b, score, t };
        }).filter((x) => x.score > 0);
        scored.sort((a, b) => b.score - a.score);
        const next = scored[0]?.b;
        if (!next) return false;
        next.click();
        return true;
    }

    function findSubmit() {
        const buttons = [...document.querySelectorAll('button, input[type="submit"], a[role="button"]')];
        const scored = buttons.map((el) => {
            if (!el) return { el, score: -1, text: '' };
            const st = window.getComputedStyle(el);
            if (st.display === 'none' || st.visibility === 'hidden' || el.closest('[hidden]')) {
                return { el, score: -1, text: '' };
            }
            const text = `${el.innerText || el.value || el.getAttribute('aria-label') || ''}`.trim().toLowerCase();
            let score = 0;
            if (/^submit$|submit application|submit your application|send application|apply now/.test(text)) score += 8;
            if (/submit application/.test(text)) score += 4;
            if (/submit|send application|apply now/.test(text)) score += 5;
            if (/submit|apply/.test(text)) score += 2;
            if (el.type === 'submit') score += 3;
            if (/withdraw|delete|cancel|unsubscribe/.test(text)) score -= 20;
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

    async function runEngine(payload) {
        const started = Date.now();
        const deadline = Number(payload?.bidDeadline) > started
            ? Number(payload.bidDeadline)
            : (started + DEFAULT_BUDGET_MS);
        const ats = detectAts();
        // Greenhouse-only engine — other ATS are filled by content/fill.js
        // via background runAutofillEngineOnTab. Do not emit blocked_ats.
        if (ats !== 'greenhouse') {
            return {
                ok: false,
                engine: ENGINE,
                useAutofill: true,
                reason: 'use_autofill_engine',
                ats
            };
        }

        const profile = payload.profile || {};
        const answers = Array.isArray(payload.answers) ? payload.answers : [];
        const answersById = new Map(answers.map((a) => [String(a.id), a.answer || a.value || '']));
        const answersByLabel = new Map(
            answers.map((a) => [String(a.label || '').trim().toLowerCase(), a.answer || a.value || ''])
        );
        const autoSubmit = !!payload.autoSubmit;
        const applicationId = payload.applicationId || null;
        const attempts = [];
        let pages = 0;
        let filled = 0;
        let requiredTotal = 0;
        let requiredOk = 0;
        let submitClicked = false;
        let stuckPages = 0;
        let lastFingerprint = '';

        const pageFingerprint = () => {
            try {
                const fields = collectFields();
                const body = fields.map((f) => `${f.id}|${f.label}|${f.type}`).join(';;').slice(0, 1800);
                return `${location.pathname}|${location.search}|${body}`;
            } catch {
                return String(location.href);
            }
        };

        while (pages < MAX_PAGES) {
            if (Date.now() > deadline) {
                return {
                    ok: false,
                    engine: ENGINE,
                    timeout: true,
                    reason: 'bid_time_budget_exceeded',
                    filled,
                    requiredTotal,
                    requiredOk,
                    attempts,
                    pages,
                    limitMs: Math.max(0, deadline - started)
                };
            }

            const fp = pageFingerprint();
            if (fp && fp === lastFingerprint) {
                stuckPages += 1;
                if (stuckPages >= 2) {
                    break; // Next did not advance — stop re-filling the same page
                }
            } else {
                stuckPages = 0;
                lastFingerprint = fp;
            }

            const fields = collectFields();
            const required = fields.filter((f) => f.required);
            requiredTotal = Math.max(requiredTotal, required.length);

            // Dial Country* first (phone-input__country → +1), before profile fields.
            try {
                const ensure = window.__lumiEnsureUsDialCode;
                if (typeof ensure === 'function') {
                    const ok = await ensure();
                    if (ok) filled += 1;
                } else {
                    // Inline fallback if fill.js hook missing
                    const country = document.getElementById('country');
                    const control = country?.closest('.select__control');
                    if (country && control && !document.querySelector(
                        '.phone-input__country .select__value-container--has-value'
                    )) {
                        control.click();
                        await sleep(120);
                        country.focus();
                        try {
                            document.execCommand('selectAll');
                            document.execCommand('insertText', false, 'United States');
                        } catch (_) {
                            setNativeValue(country, 'United States');
                        }
                        await sleep(280);
                        country.dispatchEvent(new KeyboardEvent('keydown', {
                            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
                        }));
                        await sleep(200);
                    }
                }
            } catch (_) { /* continue */ }

            for (const field of fields) {
                // Skip dial Country — already handled above (not residence country).
                if (
                    field.id === 'country'
                    || (field.kind === 'country' && document.getElementById(field.id)?.closest?.('.phone-input'))
                ) {
                    const alreadyDial = typeof window.__lumiDialCountryIsSet === 'function'
                        ? window.__lumiDialCountryIsSet()
                        : !!document.querySelector(
                            '.phone-input__country .select__value-container--has-value'
                        );
                    if (alreadyDial) {
                        filled += 1;
                        if (field.required) requiredOk += 1;
                    }
                    continue;
                }

                const wanted = profileValue(profile, answersById, answersByLabel, field, payload.jobDescription);
                if (!wanted && !field.required) continue;

                // Skip if already correct (prevents begin→end→begin overwrite).
                const already = readCurrentValue(field);
                if (wanted && valuesMatch(wanted, already, field.kind)) {
                    filled += 1;
                    if (field.required) requiredOk += 1;
                    continue;
                }

                let ok = false;
                let chosen = '';
                let strategy = '';
                let error = '';
                for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                    if (!wanted && field.required) {
                        error = 'no_value';
                        break;
                    }
                    const res = await fillOne(field, wanted, attempt, profile);
                    strategy = res.strategy || strategy;
                    chosen = res.chosen || chosen;
                    await sleep(120);
                    const got = readCurrentValue(field);
                    if (valuesMatch(wanted, got || chosen, field.kind)) {
                        ok = true;
                        chosen = got || chosen;
                        attempts.push({
                            application_id: applicationId,
                            page_index: pages,
                            field_id: field.id,
                            field_label: field.label,
                            field_kind: field.kind,
                            wanted,
                            chosen,
                            ok: true,
                            strategy,
                            attempt_n: attempt
                        });
                        filled += 1;
                        if (field.required) requiredOk += 1;
                        break;
                    }
                    if (attempt === MAX_RETRIES) {
                        attempts.push({
                            application_id: applicationId,
                            page_index: pages,
                            field_id: field.id,
                            field_label: field.label,
                            field_kind: field.kind,
                            wanted,
                            chosen: got || chosen,
                            ok: false,
                            strategy,
                            attempt_n: attempt,
                            error: 'verify_failed'
                        });
                    }
                    await sleep(200);
                }
                if (field.required && !ok) {
                    // continue trying other fields; report at end
                }
            }

            // Verify required before Next / Submit
            let stillBad = collectFields().filter((f) => {
                if (!f.required) return false;
                const wanted = profileValue(profile, answersById, answersByLabel, f, payload.jobDescription)
                    || defaultAnswerForEmptySelect(f, profile, answersById, answersByLabel, payload.jobDescription);
                return !requiredFieldSatisfied(f, wanted, readCurrentValue(f));
            });

            // Reliability sweep — empty Yes/No + Disability No (target ≥90% complete).
            if (stillBad.length > 0 || collectFields().some((f) => {
                const k = effectiveFieldKind(f) || f.kind || '';
                return (k === 'disability_status' || /\bdisabilit/i.test(f.label || ''))
                    && /^yes\b/i.test(readCurrentValue(f));
            })) {
                const n = await sweepRequiredSelects(
                    profile, answersById, answersByLabel, payload.jobDescription
                );
                filled += n;
                stillBad = collectFields().filter((f) => {
                    if (!f.required) return false;
                    const wanted = profileValue(profile, answersById, answersByLabel, f, payload.jobDescription)
                        || defaultAnswerForEmptySelect(f, profile, answersById, answersByLabel, payload.jobDescription);
                    return !requiredFieldSatisfied(f, wanted, readCurrentValue(f));
                });
            }

            if (stillBad.length === 0) {
                const hasNext = !!document.querySelectorAll('button, a[role="button"], input[type="button"]').length
                    && (() => {
                        const buttons = [...document.querySelectorAll('button, a[role="button"], input[type="button"]')];
                        return buttons.some((b) => {
                            const t = (b.innerText || b.value || '').trim().toLowerCase();
                            if (!t || /submit|apply|send application|withdraw|delete/.test(t)) return false;
                            return /^(next|continue|save and continue)$/i.test(t) || /\bnext\b|\bcontinue\b/.test(t);
                        });
                    })();
                if (!hasNext && findSubmit()) {
                    submitClicked = false;
                    if (autoSubmit) {
                        try {
                            const r = await clickSubmitSafe({ waitEnabledMs: 3200 });
                            submitClicked = !!r?.clicked;
                        } catch (_) {
                            submitClicked = false;
                        }
                    }
                    return {
                        ok: true,
                        engine: ENGINE,
                        ats,
                        filled,
                        requiredTotal: required.length,
                        requiredOk: required.length - stillBad.length,
                        requiredComplete: true,
                        readyToSubmit: true,
                        submitClicked,
                        attempts,
                        pages: pages + 1,
                        preSubmit: !submitClicked,
                        autoSubmit
                    };
                }
            } else {
                // Required fields still empty — retry pass before giving up.
                for (const f of stillBad) {
                    const wanted = profileValue(profile, answersById, answersByLabel, f, payload.jobDescription)
                        || defaultAnswerForEmptySelect(f, profile, answersById, answersByLabel, payload.jobDescription);
                    if (!wanted) continue;
                    await fillOne(f, wanted, MAX_RETRIES, profile);
                    await sleep(150);
                }
                // Second sweep after retry
                await sweepRequiredSelects(
                    profile, answersById, answersByLabel, payload.jobDescription
                );
                const retryBad = collectFields().filter((f) => {
                    if (!f.required) return false;
                    const wanted = profileValue(profile, answersById, answersByLabel, f, payload.jobDescription)
                        || defaultAnswerForEmptySelect(f, profile, answersById, answersByLabel, payload.jobDescription);
                    return !requiredFieldSatisfied(f, wanted, readCurrentValue(f));
                });
                if (retryBad.length > 0) break;
            }

            const beforeNext = pageFingerprint();
            const advanced = clickNext();
            if (!advanced) break;
            pages += 1;
            await sleep(1200);
            const afterNext = pageFingerprint();
            if (afterNext === beforeNext) {
                stuckPages += 1;
                if (stuckPages >= 2) break;
            }
        }

        // Final page sweep before scoring completeness / submit readiness.
        const sweptFinal = await sweepRequiredSelects(
            profile, answersById, answersByLabel, payload.jobDescription || ''
        );
        filled += sweptFinal;

        const finalFields = collectFields().filter((f) => f.required);
        let finalOk = 0;
        for (const f of finalFields) {
            const wanted = profileValue(profile, answersById, answersByLabel, f, payload.jobDescription || '')
                || defaultAnswerForEmptySelect(f, profile, answersById, answersByLabel, payload.jobDescription || '');
            if (requiredFieldSatisfied(f, wanted, readCurrentValue(f))) finalOk += 1;
        }
        const requiredComplete = finalFields.length === 0
            ? filled > 0
            : finalOk === finalFields.length;
        const ready = requiredComplete && !!findSubmit();

        submitClicked = false;
        if (ready && autoSubmit) {
            try {
                const r = await clickSubmitSafe({ waitEnabledMs: 3200 });
                submitClicked = !!r?.clicked;
            } catch (_) {
                submitClicked = false;
            }
        }

        return {
            ok: requiredComplete,
            engine: ENGINE,
            ats,
            filled,
            requiredTotal: finalFields.length,
            requiredOk: finalOk,
            requiredComplete,
            readyToSubmit: ready,
            submitClicked,
            attempts,
            pages: pages + 1,
            preSubmit: ready && !submitClicked,
            autoSubmit,
            swept: sweptFinal,
            missingRequired: finalFields
                .filter((f) => {
                    const wanted = profileValue(profile, answersById, answersByLabel, f, '')
                        || defaultAnswerForEmptySelect(f, profile, answersById, answersByLabel, '');
                    return !requiredFieldSatisfied(f, wanted, readCurrentValue(f));
                })
                .map((f) => fieldMissingLabel(f))
                .filter(Boolean)
        };
    }

    async function clickSubmitSafe({ waitEnabledMs = 3000 } = {}) {
        let btn = findSubmit();
        if (!btn) return { clicked: false, reason: 'no_submit' };
        const start = Date.now();
        while (
            (btn.disabled || btn.getAttribute('aria-disabled') === 'true')
            && Date.now() - start < waitEnabledMs
        ) {
            await new Promise((r) => setTimeout(r, 200));
            btn = findSubmit() || btn;
        }
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

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg?.type === 'BIDDER_ENGINE_INFO') {
            sendResponse({ ok: true, engine: ENGINE, ats: detectAts() });
            return false;
        }
        if (msg?.type === 'BIDDER_ENGINE_COLLECT') {
            try {
                const ats = detectAts();
                if (ats !== 'greenhouse') {
                    // Soft handoff — background uses fill.js for Oracle/Workday/etc.
                    sendResponse({
                        ok: false,
                        useAutofill: true,
                        ats,
                        reason: 'use_autofill_engine',
                        engine: ENGINE
                    });
                    return false;
                }
                const fields = collectFields();
                const API_KINDS = new Set([
                    'question', 'salary', 'work_authorization', 'requires_sponsorship',
                    'previous_employer_no', 'years_of_experience', 'willing_to_relocate',
                    'over_18', 'how_heard', 'data_protection', 'employer_count',
                    'high_school_performance', 'high_school_rationale', 'degree_result',
                    'sanctioned_countries_no', 'export_control_us_citizen', 'immigration_na_if_citizen',
                    'onsite_hub_yes', 'us_person_yes', 'disability_status'
                ]);
                const questions = fields
                    .filter((f) => API_KINDS.has(f.kind))
                    .map((f) => ({
                        id: f.id,
                        label: f.label,
                        kind: f.kind,
                        type: f.type,
                        answer_type: f.kind === 'salary'
                            ? 'salary'
                            : (Array.isArray(f.options) && f.options.length ? 'choice' : 'written'),
                        options: Array.isArray(f.options)
                            ? f.options.map((o) => (typeof o === 'string' ? o : (o?.label || o?.value || ''))).filter(Boolean)
                            : undefined
                    }));
                sendResponse({
                    ok: true,
                    engine: ENGINE,
                    ats,
                    fields,
                    questions
                });
            } catch (err) {
                sendResponse({ ok: false, error: err?.message || String(err) });
            }
            return false;
        }
        if (msg?.type === 'BIDDER_ENGINE_RUN') {
            runEngine(msg.payload || {})
                .then((result) => sendResponse({ ok: true, result }))
                .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
            return true;
        }
        if (msg?.type === 'BIDDER_ENGINE_SUBMIT') {
            (async () => {
                try {
                    const force = !!msg.force;
                    let btn = findSubmit();
                    if (!btn) {
                        sendResponse({ ok: true, clicked: false, reason: 'no_submit' });
                        return;
                    }
                    // Wait for Greenhouse to enable Submit after React validation.
                    const waitStart = Date.now();
                    while (
                        (btn.disabled || btn.getAttribute('aria-disabled') === 'true')
                        && Date.now() - waitStart < 3200
                    ) {
                        await sleep(200);
                        btn = findSubmit() || btn;
                    }
                    const siteReady = !(
                        btn.disabled || btn.getAttribute('aria-disabled') === 'true'
                    );

                    const required = collectFields().filter((f) => f.required);
                    const missing = required.filter((f) => {
                        const cur = readCurrentValue(f);
                        return !cur || !String(cur).trim();
                    });
                    // Greenhouse enabled Submit = site validation passed. Our React
                    // select reader often false-empties filled EE/Yes-No fields — do
                    // not block the click when the blue Submit button is ready.
                    if (missing.length && !force && !siteReady) {
                        sendResponse({
                            ok: true,
                            clicked: false,
                            reason: 'required_incomplete',
                            missing: missing.map((f) => f.label).slice(0, 12),
                            siteReady: false
                        });
                        return;
                    }
                    const r = await clickSubmitSafe({ waitEnabledMs: 800 });
                    sendResponse({
                        ok: true,
                        ...r,
                        forced: force || (missing.length > 0 && siteReady),
                        siteReady,
                        missing: missing.length ? missing.map((f) => f.label).slice(0, 12) : undefined
                    });
                } catch (err) {
                    sendResponse({ ok: false, error: err?.message || String(err) });
                }
            })();
            return true;
        }
        return false;
    });
}());
