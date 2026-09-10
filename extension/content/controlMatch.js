/**
 * Shared select / radio / checkbox matching — Simplify / JobWizard patterns.
 * Loaded before fill.js and bidderFill.js (window.__lumiControlMatch).
 *
 * Rules:
 * - Open custom menus before reading options; never dump raw text into a closed select.
 * - Score by meaning; short Yes/No must not substring-match unrelated options.
 * - Negation-aware consent: never pick "I do not consent" when wanting Yes.
 * - Prefer exact short Yes/No over longer near-matches when both score high.
 * - Click the label (or full pointer sequence), then verify the control stuck.
 */
(function () {
    if (window.__lumiControlMatch) return;
    const api = {};

    api.normalize = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

    api.isPlaceholderOption = (text, value = '') => {
        const t = api.normalize(text);
        const v = api.normalize(value);
        if (!t && !v) return true;
        if (/^select(\.\.\.|…|:)?$/.test(t) || /^choose(\s+one)?(\.\.\.|…|:)?$/.test(t)) return true;
        if (/^please select|^type to search|^start typing|^search(\.\.\.|…)?$/.test(t)) return true;
        if (v === '' && (/^-+$/.test(t) || t === '—')) return true;
        return false;
    };

    api.hasNegation = (text) => {
        const t = api.normalize(text);
        if (!t) return false;
        // "None of the above" is not a Yes/No negation answer.
        if (/^none\b/.test(t) || /\bnone of (the|these|above)\b/.test(t)) return false;
        if (/\bnot applicable\b|\bn\/a\b/.test(t) && !/\bdo not\b|\bdon't\b/.test(t)) return false;
        return /\b(do not|don't|dont|does not|did not|will not|won't|cannot|can't|never|disagree|decline|refuse|not consent|do not consent|i do not|i don't|unable|not authorized)\b/.test(t)
            || /^(no|n)\b/.test(t);
    };

    api.isAffirmative = (want) => {
        const w = api.normalize(want);
        if (!w) return false;
        if (api.hasNegation(w)) return false;
        return /^(yes|y|true|1|agree|accept|consent|i agree|i consent|i understand|understood|acknowledged|checked|on)$/.test(w)
            || /^(i )?(agree|consent|accept|acknowledge|understand)\b/.test(w);
    };

    api.isNegative = (want) => {
        const w = api.normalize(want);
        if (!w) return false;
        if (/^(no|n|false|0|disagree|decline|refuse)$/.test(w)) return true;
        return api.hasNegation(w);
    };

    /**
     * Collapse long LLM / profile answers to Yes/No when the option list is bipolar.
     * "I am authorized to work…" → Yes; "I will not need sponsorship" → No.
     */
    api.canonicalizeWant = (want) => {
        const raw = String(want || '').trim();
        if (!raw) return '';
        const w = api.normalize(raw);
        if (/^(yes|y|true|1)$/.test(w) || /^(no|n|false|0)$/.test(w)) {
            return /^(yes|y|true|1)$/.test(w) ? 'Yes' : 'No';
        }
        if (api.isAffirmative(w) && !api.isNegative(w)) return 'Yes';
        if (api.isNegative(w)) return 'No';
        // Sponsorship-style free text
        if (/\b(do not|don't|will not|won't|no(t)?)\b/.test(w)
            && /\b(sponsor|visa|need|require)\b/.test(w)) {
            return 'No';
        }
        if (/\b(authorized|eligible|legally)\b/.test(w) && !api.hasNegation(w)) return 'Yes';
        if (/\b(not authorized|not eligible|unauthorized)\b/.test(w)) return 'No';
        return raw;
    };

    /**
     * Score an option against a wanted answer.
     * Returns -1 when the option must not be chosen (esp. consent negation).
     */
    api.scoreChoice = (want, optionText, optionValue = '') => {
        let w = api.normalize(want);
        const t = api.normalize(optionText);
        const ov = api.normalize(optionValue);
        if (!w || (!t && !ov)) return -1;
        if (api.isPlaceholderOption(optionText, optionValue)) return -1;

        // Hard gate FIRST: Disability No must never score a Yes option (substring trap:
        // "do not have a disability" contains "have a disability").
        const disPolarityYes = (s) => {
            const x = api.normalize(s);
            if (/do not have|don'?t have|have not had|no disability|not disabled|^no\b/.test(x)) {
                return false;
            }
            return /^yes\b/.test(x) || /have a disability|have had one in the past/.test(x);
        };
        const disPolarityNo = (s) => {
            const x = api.normalize(s);
            return /^no\b/.test(x)
                || /do not have a disability|don'?t have a disability|have not had one|no disability|not disabled/.test(x);
        };
        if (/disabilit/.test(w + t + ov)) {
            const wantNo = disPolarityNo(w) || (api.isNegative(w) && /disabilit/.test(w))
                || (/^no\b/.test(w) && /disabilit/.test(t + ov));
            const wantYes = disPolarityYes(w);
            const optYes = disPolarityYes(t) || disPolarityYes(ov);
            const optNo = disPolarityNo(t) || disPolarityNo(ov);
            if (wantNo && optYes && !optNo) return -1;
            if (wantNo && optNo) return 99;
            if (wantYes && optNo && !optYes) return -1;
            if (wantYes && optYes) return 99;
        }
        // Extra: want short "No" vs disability Yes option (even if want text omitted "disability").
        if ((/^no\b/.test(w) || api.isNegative(w)) && !disPolarityYes(w)
            && (/^yes\b/.test(t) || /^yes\b/.test(ov))
            && /disabilit|have had one in the past|disabled/.test(t + ov)
            && !/do not have|don'?t have|have not had|no disability/.test(t + ov)) {
            return -1;
        }

        // Sponsorship / visa: want No must never score a Yes option.
        if (/\b(sponsor|sponsorship|visa|h-?1b)\b/.test(w + t + ov)
            && !(/\b(authorized|authorised|eligible)\b/.test(w) && /\bwithout\s+(?:visa\s+)?sponsorship\b/.test(w))) {
            const wantNoSponsor = api.isNegative(w) || /^(no|n)\b/.test(w)
                || (/\b(do not|don'?t|will not|won'?t|no(t)?)\b/.test(w) && /\b(sponsor|visa|need|require)\b/.test(w));
            const wantYesSponsor = (api.isAffirmative(w) || /^(yes|y)\b/.test(w)) && !wantNoSponsor;
            const optYes = /^(yes|y)\b/.test(t) || /^(yes|y)\b/.test(ov)
                || (/\b(require|need)\b/.test(t + ov) && /\b(sponsor|visa)\b/.test(t + ov) && !api.hasNegation(t + ov));
            const optNo = (/^(no|n)\b/.test(t) || /^(no|n)\b/.test(ov) || api.hasNegation(t + ov))
                && !/^(yes|y)\b/.test(t);
            if (wantNoSponsor && optYes && !optNo) return -1;
            if (wantNoSponsor && optNo) return 99;
            if (wantYesSponsor && optNo && !optYes) return -1;
            if (wantYesSponsor && optYes) return 98;
        }

        // Former employee / prior employer at company: want No must never score Yes.
        if (/\b(former|previously worked|have you (ever )?worked|employed by|contingent worker)\b/.test(w + t + ov)
            || (/\bemployee\b/.test(w + t + ov) && /\b(former|ever|previously)\b/.test(w + t + ov))) {
            const wantNoPrior = api.isNegative(w) || /^(no|n)\b/.test(w);
            const optYes = /^(yes|y)\b/.test(t) || /^(yes|y)\b/.test(ov);
            const optNo = (/^(no|n)\b/.test(t) || /^(no|n)\b/.test(ov)) && !/^(yes|y)\b/.test(t);
            if (wantNoPrior && optYes && !optNo) return -1;
            if (wantNoPrior && optNo) return 99;
        }

        // Long wants that clearly mean Yes/No → score as Yes/No against short options.
        // Keep original text for EEO disability / veteran long-form matching below.
        const wantRawNorm = w;
        const canon = api.canonicalizeWant(want);
        if ((canon === 'Yes' || canon === 'No') && w.length > 12) {
            w = api.normalize(canon);
        }

        const wantYes = api.isAffirmative(w) || w === 'yes' || w === 'y';
        const wantNo = api.isNegative(w) || w === 'no' || w === 'n';
        const optNeg = api.hasNegation(t) || api.hasNegation(ov);
        const tShort = t.length <= 12;

        // Exact short Yes/No always wins over long consent paragraphs in the same list.
        if (wantYes && /^(yes|y|true|1)$/.test(t) && tShort) return 100;
        if (wantNo && /^(no|n|false|0)$/.test(t) && tShort && !/^not\b/.test(t)) return 100;
        // Value-coded Yes/No (common on Lever/Ashby)
        if (wantYes && /^(yes|y|true|1)$/.test(ov)) return 98;
        if (wantNo && /^(no|n|false|0)$/.test(ov)) return 98;

        // Consent / Yes-No gate used by Simplify-class tools.
        if (wantYes && optNeg) return -1;
        if (wantNo && !optNeg && /^(yes|y|i agree|i consent|agree|accept)\b/.test(t) && t.length < 48) {
            return -1;
        }
        if (wantYes && !optNeg && /\backnowledg/.test(t)) return 97;
        if (wantYes && !optNeg && /\b(i have read|i agree|i consent|i accept|i understand)\b/.test(t)) return 96;
        if (wantYes && !optNeg && /^(yes|y|i agree|i consent|i understand|agree|accept|understand)\b/.test(t)) {
            // Prefer bare "Yes" over "Yes, I require sponsorship" when wanting Yes.
            return tShort ? 96 : 88;
        }
        if (wantNo && optNeg && (/\bconsent\b|\bagree\b|\backnowledg|\bunderstand\b/.test(t) || t.length > 40)) {
            return 96;
        }
        // (legacy disability block removed — hard gate at top of scoreChoice)
        if (/not a protected veteran|i am not a veteran|no,? i am not/.test(wantRawNorm)
            && /not a protected veteran|i am not a|no,? i am not/.test(t)) {
            return 92;
        }
        if (wantNo && /^(no|n|false|0)\b/.test(t) && !/^not\b/.test(t) && !/\bnone\b/.test(t)) {
            return tShort ? 94 : 86;
        }

        // Explicit "I acknowledge" / data-protection style wants
        if (/\backnowledg/.test(w) && !optNeg && /\b(acknowledg|agree|consent|accept|i have read)\b/.test(t)) {
            return 95;
        }

        if (t === w || ov === w || t === wantRawNorm || ov === wantRawNorm) return 100;

        // City / location typeahead BEFORE generic startsWith — otherwise
        // "Palo Alto, CA" prefix-matches "Palo Alto, California…" at only 82
        // and we keep typing instead of clicking the top hint.
        {
            const cityWant = w.split(',')[0].trim();
            const cityOpt = t.split(',')[0].trim();
            const looksLikeLocationOpt = /,\s*(united states|[a-z]{2}\b|[a-z ]+,)/.test(t)
                || /\bunited states\b/.test(t);
            const looksLikeLocationWant = /,\s*[a-z]{2}\b/.test(w) || /,\s*[a-z .'-]+$/.test(w);
            if (looksLikeLocationWant || looksLikeLocationOpt) {
                if (cityWant.length >= 3 && cityOpt.length >= 3) {
                    if (cityWant === cityOpt) return 94;
                    if (cityOpt.startsWith(cityWant) || cityWant.startsWith(cityOpt)) return 90;
                    if (t.startsWith(cityWant) || t.includes(`${cityWant},`)) return 88;
                }
                if (cityWant.length >= 3 && t.includes(cityWant)) {
                    if (/\bca\b/.test(w) && /\bcalifornia\b/.test(t)) return 86;
                    if (/\bny\b/.test(w) && /\bnew york\b/.test(t)) return 86;
                    if (/\btx\b/.test(w) && /\btexas\b/.test(t)) return 86;
                    if (/\bwa\b/.test(w) && /\bwashington\b/.test(t)) return 86;
                }
            }
        }

        // Gender synonyms (before short-token gate — "man"/"male" are ≤3 chars).
        const gender = {
            man: ['male', 'man', 'm'],
            male: ['male', 'man', 'm'],
            woman: ['female', 'woman', 'f'],
            female: ['female', 'woman', 'f']
        };
        const gKeys = gender[w];
        if (gKeys && gKeys.some((g) => t === g || ov === g || t.startsWith(`${g} `))) return 90;

        // Country / US synonyms
        if (/^(united states|usa|u\.?s\.?a?\.?|us)$/.test(w)) {
            if (/^(united states|usa|u\.?s\.?a?\.?|us|united states of america)$/.test(t)
                || /^(us|usa|united states)$/.test(ov)) {
                return 95;
            }
        }

        // Years of experience: map profile years onto option bands (never pick 0-2 for 15+).
        if (/\d/.test(w) && (/\d/.test(t) || /\d/.test(ov))) {
            const parseWant = (s) => {
                const x = String(s || '').toLowerCase();
                let m = x.match(/(\d+)\s*\+/) || x.match(/(\d+)\s*or more/) || x.match(/more than\s*(\d+)/);
                if (m) return parseInt(m[1], 10);
                m = x.match(/(\d+)\s*[-–]\s*(\d+)/);
                if (m) return parseInt(m[2], 10);
                m = x.match(/(\d+)/);
                return m ? parseInt(m[1], 10) : NaN;
            };
            const parseRange = (s) => {
                const x = String(s || '').toLowerCase();
                let m = x.match(/(\d+)\s*\+/) || x.match(/(\d+)\s*or more/) || x.match(/more than\s*(\d+)/);
                if (m) return { min: parseInt(m[1], 10), max: Infinity };
                m = x.match(/(\d+)\s*[-–]\s*(\d+)/);
                if (m) return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };
                m = x.match(/less than\s*(\d+)/);
                if (m) return { min: 0, max: Math.max(0, parseInt(m[1], 10) - 1) };
                return null;
            };
            const wv = parseWant(w);
            const range = parseRange(t) || parseRange(ov);
            if (Number.isFinite(wv) && range) {
                if (Number.isFinite(range.max) && wv > range.max) return -1;
                if (wv >= range.min && wv <= range.max) {
                    return range.max === Infinity ? 98 : 94;
                }
                if (wv >= 10 && range.max === Infinity) return 96;
            }
            const wn = w.match(/(\d+)\s*\+?/);
            const tn = (t + ' ' + ov).match(/(\d+)\s*\+?/);
            if (wn && tn) {
                const a = parseInt(wn[1], 10);
                const b = parseInt(tn[1], 10);
                if (a === b && /\+/.test(t + ov + w)) return 92;
                if (a >= 10 && b >= 10 && /\+|or more|more than|at least/.test(t + ov + w)) return 88;
            }
        }

        // Degree synonyms
        if (/bachelor/.test(w) && /bachelor/.test(t) && !/master|doctor|associate|phd/.test(t)) return 88;
        if (/master/.test(w) && /master/.test(t) && !/bachelor|doctor|associate/.test(t)) return 88;
        if (/\b(ph\.?d|doctorate)\b/.test(w) && /\b(ph\.?d|doctorate)\b/.test(t)) return 88;

        if (/not a protected veteran|i am not a veteran|no,? i am not/.test(wantRawNorm)
            && /not a protected veteran|i am not a|no,? i am not/.test(t)) {
            return 92;
        }
        if (/prefer not|do not want to answer|decline to/.test(w)
            && /prefer not|do not want to answer|decline|choose not/.test(t)) {
            return 90;
        }

        // Race / ethnicity synonyms (ATS option phrasing varies a lot)
        const raceBuckets = [
            {
                want: /asian|east asian|south asian|southeast asian/,
                opt: /\basian\b|east asian|south asian|southeast asian/
            },
            {
                want: /black|african american|african-american/,
                opt: /black|african american|african-american/
            },
            {
                want: /\bwhite\b|caucasian|european/,
                opt: /\bwhite\b|caucasian/
            },
            {
                want: /hispanic|latino|latina|latinx/,
                opt: /hispanic|latino|latina|latinx/
            },
            {
                want: /native american|american indian|alaska native|indigenous/,
                opt: /native american|american indian|alaska native|indigenous/
            },
            {
                want: /pacific islander|native hawaiian|hawaii/,
                opt: /pacific islander|native hawaiian|hawaii|oceania/
            },
            {
                want: /two or more|multiracial|mixed|more than one/,
                opt: /two or more|multiracial|mixed|more than one/
            }
        ];
        for (const b of raceBuckets) {
            if (b.want.test(w) && b.opt.test(t) && !/prefer not|decline|do not want/.test(t)) {
                return 90;
            }
        }

        // Short tokens (No, US, CA, Yes) — exact / boundary only.
        if (w.length <= 3) {
            if (t === w || ov === w) return 100;
            if (t.startsWith(`${w} `) || t.startsWith(`${w},`) || t.startsWith(`${w}.`)) return 88;
            if (ov === w) return 90;
            return -1;
        }

        if (t.startsWith(w) || ov.startsWith(w)) return 82;
        // Substring: only when option is not much longer noise (avoids random long hits).
        if (t.includes(w) || ov.includes(w)) {
            if (t.length <= w.length + 24) return 76;
            return 68;
        }
        if (w.length > 4 && w.includes(t) && t.length >= 4) return 72;

        const tokens = w.split(/\s+/).filter((x) => x.length > 2);
        if (tokens.length) {
            const hit = tokens.filter((tok) => t.includes(tok) || ov.includes(tok)).length;
            const ratio = hit / tokens.length;
            if (ratio >= 0.6) return Math.round(ratio * 72); // was *55 (often <70)
        }

        return -1;
    };

    /**
     * Pick best option — skips placeholders; on score ties prefer shorter exact-ish labels.
     */
    api.matchNativeOption = (opts, value, minScore = 65) => {
        const list = Array.from(opts || []).filter((o) =>
            !api.isPlaceholderOption(o.text || o.label || '', o.value || '')
        );
        const scored = list.map((o) => {
            const text = o.text || o.label || '';
            const score = api.scoreChoice(value, text, o.value || '');
            return { o, score, len: String(text).length };
        }).filter((x) => x.score >= minScore);
        scored.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            // Tie: prefer shorter option ("Yes" over "Yes, and…")
            return a.len - b.len;
        });
        return scored[0]?.o || null;
    };

    api.wantCheckboxOn = (value, label = '') => {
        const raw = String(value || '').trim();
        const lab = api.normalize(label);
        if (api.isNegative(raw)) return false;
        // Sponsorship / visa checkboxes: only ON when explicitly Yes.
        if (/\b(sponsor|sponsorship|visa)\b/.test(lab)) {
            return api.isAffirmative(raw);
        }
        // Work authorization checkboxes: ON unless explicitly No.
        if (/\b(authoriz|eligible to work|legally authorized|work auth)\b/.test(lab)) {
            if (!raw) return true;
            return !api.isNegative(raw);
        }
        if (api.isAffirmative(raw)) return true;
        // Consent / terms: default ON when answer empty or affirmative-ish.
        if (/\b(agree|acknowledg|consent|terms|certify|confirm|understand)\b/.test(lab)) {
            return !raw || !api.isNegative(raw);
        }
        // Previous employer / "have you ever" — usually want OFF (No).
        if (/\b(previously worked|have you ever|former employee|employed by|working for|contractor|contingent worker)\b/.test(lab)) {
            return api.isAffirmative(raw);
        }
        // Retain-data / talent-pool checkboxes — always ON.
        if (/\b(retain|future opportunit|talent pool|keep my (data|application)|consider me for)\b/.test(lab)) {
            return !api.isNegative(raw);
        }
        return false;
    };

    /** Full pointer sequence — React/Greenhouse often ignore bare .click(). */
    api.dispatchTrustedClick = (el) => {
        if (!el) return false;
        try {
            el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } catch (_) { /* ignore */ }
        const types = ['pointerdown', 'mousedown', 'mouseup', 'click'];
        for (const type of types) {
            try {
                el.dispatchEvent(new MouseEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                    buttons: 1
                }));
            } catch (_) { /* ignore */ }
        }
        try { el.click(); } catch (_) { /* ignore */ }
        return true;
    };

    /** Prefer label click (Workday/Greenhouse hide native inputs). */
    api.clickInputViaLabel = (input) => {
        if (!input) return false;
        const lab = input.closest('label')
            || (input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`));
        if (lab) {
            api.dispatchTrustedClick(lab);
            return true;
        }
        // Sibling / parent option wrappers (Greenhouse / Lever custom radios)
        const wrap = input.closest(
            '[class*="answer-alternative"], [class*="application-answer"], '
            + '[class*="radio-option"], [class*="RadioOption"], [role="radio"], '
            + 'li.application-answer, .application-answer'
        );
        if (wrap) {
            api.dispatchTrustedClick(wrap);
            return true;
        }
        api.dispatchTrustedClick(input);
        return true;
    };

    window.__lumiControlMatch = api;
})();
