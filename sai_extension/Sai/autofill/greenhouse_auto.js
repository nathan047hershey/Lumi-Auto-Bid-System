/**
 * autofill/greenhouse_auto.js
 * Greenhouse-only autofill. Isolated from Workday / shared dock logic.
 */
(function () {
  'use strict';

  const LOG = '[Sai:Greenhouse]';

  function isGreenhousePage() {
    const host = location.hostname.toLowerCase();
    return (
      host === 'boards.greenhouse.io' ||
      host === 'job-boards.greenhouse.io' ||
      host.endsWith('.greenhouse.io')
    );
  }

  // Do not mark loaded on non-Greenhouse frames (all_frames inject)
  if (!isGreenhousePage()) return;
  if (window.__saiGreenhouseAutoLoaded) return;
  window.__saiGreenhouseAutoLoaded = true;

  const STATE = {
    running: false,
    stop: false,
    paused: false,
    offerShown: false,
    offerDismissed: false
  };

  console.log(LOG, 'module loaded on', location.href);

  // ── Public API ────────────────────────────────────────────────────────
  window.__saiGreenhouse = {
    platform: 'greenhouse',
    isReady: () => !!findApplicationForm(),
    getJobDescription,
    startAutofill: runAutofill,
    stopAutofill: () => {
      STATE.stop = true;
    }
  };

  // ── Boot: load module only (no text offer UI) ─────────────────────────
  // bootOffer() disabled — actions live in the Sai dock toolbar.

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || (message.platform && message.platform !== 'greenhouse')) return;

    if (message.type === 'greenhousePing') {
      sendResponse({
        success: true,
        platform: 'greenhouse',
        ready: !!findApplicationForm(),
        hasJd: !!getJobDescription(),
        offerShown: !!document.getElementById('sai-greenhouse-offer'),
        href: location.href
      });
      return;
    }

    if (message.type === 'greenhouseShowOffer') {
      document.getElementById('sai-greenhouse-offer')?.remove();
      sendResponse({ success: true, offerShown: false, skipped: true });
      return;
    }

    if (message.type === 'fillGreenhouseProfile') {
      Promise.resolve(runAutofill({ profile: message.profile }))
        .then((result) => sendResponse({ success: true, ...(result || {}) }))
        .catch((error) => sendResponse({ success: false, error: error.message }));
      return true;
    }

    if (message.type === 'greenhouseStopAutofill') {
      STATE.stop = true;
      sendResponse({ success: true });
    }
  });

  function bootOffer() {
    const tryShow = () => {
      if (STATE.running || STATE.offerDismissed) return true;
      if (!document.getElementById('sai-greenhouse-offer')) {
        STATE.offerShown = false;
        showOfferUi();
      }
      return true;
    };

    if (document.body) tryShow();
    else document.addEventListener('DOMContentLoaded', tryShow, { once: true });

    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      tryShow();
      if (tries > 40) clearInterval(timer);
    }, 500);

    const obs = new MutationObserver(() => {
      if (STATE.running || STATE.offerDismissed) return;
      if (!document.getElementById('sai-greenhouse-offer')) {
        STATE.offerShown = false;
        showOfferUi();
      }
      window.__saiUpdateLayoutOffset?.();
      window.top?.__saiUpdateLayoutOffset?.();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ── UI: chat-style offer (hidden during fill — magic HUD takes over) ──
  function showOfferUi() {
    if (STATE.offerDismissed) return;
    if (STATE.offerShown || document.getElementById('sai-greenhouse-offer')) {
      STATE.offerShown = true;
      return;
    }
    STATE.offerShown = true;
    console.log(LOG, 'showing autofill offer');

    ensureOfferStyles();
    document.getElementById('sai-greenhouse-offer-fallback')?.remove();

    const wrap = document.createElement('div');
    wrap.id = 'sai-greenhouse-offer';
    wrap.className = 'sai-gh-chat';
    wrap.innerHTML = `
      <div class="sai-gh-chat-offer" id="sai-gh-offer-msg">
        <button type="button" class="sai-gh-chat-bubble" id="sai-gh-start">
          <span class="sai-gh-chat-text">I can auto fill this job ✨</span>
        </button>
        <button type="button" class="sai-gh-chat-bubble sai-gh-chat-bubble--cv" id="sai-gh-generate-cv">
          <span class="sai-gh-chat-text">Generate CV 📄</span>
        </button>
      </div>
    `;
    (document.body || document.documentElement).appendChild(wrap);

    window.__saiUpdateLayoutOffset?.();
    window.top?.__saiUpdateLayoutOffset?.();

    wrap.querySelector('#sai-gh-start').addEventListener('click', () => {
      startFromUi().catch((err) => toast(err.message || 'Autofill failed', 'error'));
    });

    wrap.querySelector('#sai-gh-generate-cv').addEventListener('click', () => {
      generateCvFromPage().catch((err) => toast(err.message || 'CV generation failed', 'error'));
    });
  }

  async function generateCvFromPage() {
    const jd = getJobDescription();
    if (!jd) throw new Error('Job description not found on this page');
    toast('Generating CV…', 'info');
    try {
      await navigator.clipboard.writeText(jd);
    } catch (_) {}
    const res = await chrome.runtime.sendMessage({ type: 'tryJdHandoff', text: jd });
    if (!res?.handoff) throw new Error(res?.error || 'CV generation failed');
    toast('CV generating on platform tab', 'success');
  }

  function ensureOfferStyles() {
    if (document.getElementById('sai-gh-offer-style')) return;
    const style = document.createElement('style');
    style.id = 'sai-gh-offer-style';
    style.textContent = `
      #sai-greenhouse-offer.sai-gh-chat {
        position: fixed !important;
        top: 78px !important;
        right: var(--sai-float-right, 24px) !important;
        z-index: 2147483647 !important;
        display: flex !important;
        flex-direction: column !important;
        align-items: flex-end !important;
        gap: 8px !important;
        font-family: "Segoe UI", system-ui, sans-serif !important;
        pointer-events: none !important;
        max-width: 280px !important;
      }
      #sai-greenhouse-offer.sai-gh-chat > * { pointer-events: auto !important; }
      #sai-greenhouse-offer .sai-gh-chat-offer,
      #sai-greenhouse-offer-fallback {
        display: flex !important;
        flex-direction: column !important;
        align-items: flex-end !important;
        gap: 8px !important;
      }
      .sai-gh-chat-bubble {
        position: relative !important;
        display: block !important;
        border: none !important;
        cursor: pointer !important;
        text-align: left !important;
        padding: 10px 14px !important;
        border-radius: 16px 16px 4px 16px !important;
        background: #fff !important;
        box-shadow: 0 8px 24px rgba(15,23,42,0.12) !important;
        border: 1px solid rgba(148,163,184,0.35) !important;
        color: #1e293b !important;
      }
      .sai-gh-chat-bubble::after {
        content: "" !important;
        position: absolute !important;
        top: -6px !important;
        right: 28px !important;
        width: 12px !important;
        height: 12px !important;
        background: #fff !important;
        border-top: 1px solid rgba(148,163,184,0.35) !important;
        border-left: 1px solid rgba(148,163,184,0.35) !important;
        transform: rotate(45deg) !important;
      }
      .sai-gh-chat-text {
        font-size: 13px !important;
        font-weight: 600 !important;
        line-height: 1.35 !important;
        color: #1e293b !important;
      }
      .sai-gh-chat-bubble--cv {
        background: linear-gradient(135deg, #f5f3ff 0%, #ede9fe 100%) !important;
        border-color: rgba(124, 58, 237, 0.35) !important;
      }
      .sai-gh-chat-bubble--cv .sai-gh-chat-text {
        color: #5b21b6 !important;
      }
      #sai-greenhouse-offer.sai-gh-chat--filling {
        display: none !important;
      }
      .sai-gh-toast {
        position: fixed !important; bottom: 24px !important; right: var(--sai-float-right, 24px) !important;
        z-index: 2147483647 !important; padding: 12px 16px !important; border-radius: 14px !important;
        background: #fff !important; color: #1e293b !important;
        font: 600 13px/1.4 "Segoe UI", system-ui, sans-serif !important;
        box-shadow: 0 12px 28px rgba(15,23,42,0.15) !important;
        opacity: 0; transform: translateY(10px); transition: opacity .25s, transform .25s;
        max-width: 320px !important;
      }
      .sai-gh-toast-show { opacity: 1 !important; transform: translateY(0) !important; }
      .sai-gh-toast--error { color: #b91c1c !important; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function enterFillControls() {
    STATE.offerDismissed = true;
    document.getElementById('sai-greenhouse-offer-fallback')?.remove();
    const wrap = document.getElementById('sai-greenhouse-offer');
    if (wrap) wrap.classList.add('sai-gh-chat--filling');
  }

  function exitFillControls({ restoreOffer = true } = {}) {
    const wrap = document.getElementById('sai-greenhouse-offer');
    if (wrap) wrap.classList.remove('sai-gh-chat--filling');
    if (restoreOffer) {
      STATE.offerDismissed = false;
      const offer = document.getElementById('sai-gh-offer-msg');
      if (!offer) {
        STATE.offerShown = false;
        document.getElementById('sai-greenhouse-offer')?.remove();
        showOfferUi();
      }
    } else {
      document.getElementById('sai-greenhouse-offer')?.remove();
      STATE.offerShown = false;
    }
  }

  function setOfferBusy(busy) {
    if (busy) enterFillControls();
    else exitFillControls({ restoreOffer: true });
  }

  async function startFromUi() {
    if (STATE.running) return { skipped: true };
    enterFillControls();
    toast('Starting Greenhouse autofill…', 'info');
    try {
      try {
        const jd = getJobDescription();
        if (jd) {
          await chrome.runtime.sendMessage({ type: 'tryJdHandoff', text: jd });
        }
      } catch (_) {}

      const res = await chrome.runtime.sendMessage({
        type: 'greenhouseStartAutofill',
        platform: 'greenhouse'
      });
      if (!res?.success) throw new Error(res?.error || 'Autofill failed');
      toast(`Filled ${res.filled || 0} fields`, 'success');
      return res;
    } catch (err) {
      exitFillControls({ restoreOffer: true });
      throw err;
    }
  }

  // ── DOM roots ─────────────────────────────────────────────────────────
  function findApplicationForm() {
    return (
      document.querySelector('form#application-form') ||
      document.querySelector('#application-form') ||
      document.querySelector('#application_form') ||
      document.querySelector('form.application--form') ||
      document.querySelector('.application--container form') ||
      document.querySelector('form[action*="job_app"]') ||
      document.querySelector('form[action*="greenhouse"]') ||
      null
    );
  }

  function getQuestionBlocks() {
    const form = findApplicationForm();
    if (!form) return { block1: null, block2: null };
    const blocks = Array.from(form.querySelectorAll('.application--questions'));
    return { block1: blocks[0] || null, block2: blocks[1] || null };
  }

  function getEducationRoot() {
    const form = findApplicationForm();
    return form?.querySelector('.education--container, .education--form') || null;
  }

  function getEmploymentRoot() {
    const form = findApplicationForm();
    return form?.querySelector('.employment--container, .employment-form') || null;
  }

  function getEeocRoot() {
    const form = findApplicationForm();
    // Prefer explicit EEOC containers — never treat demographic Voluntary Self ID as EEOC
    const root =
      form?.querySelector('.eeoc_container, .eeoc__container') ||
      document.querySelector('.eeoc_container, .eeoc__container') ||
      null;
    if (!root) return null;
    if (root.id === 'demographic-section' || root.closest?.('#demographic-section')) return null;
    return root;
  }

  function getDemographicRoot() {
    return (
      document.querySelector('#demographic-section') ||
      findApplicationForm()?.querySelector('.demographic--container') ||
      null
    );
  }

  function getJobDescription() {
    const el =
      document.querySelector('.job__description.body') ||
      document.querySelector('.job__description') ||
      document.querySelector('[class*="job__description"]');
    const text = (el?.innerText || el?.textContent || '').trim();
    return text.length > 40 ? text : '';
  }

  // ── Autofill orchestrator ─────────────────────────────────────────────
  async function runAutofill(options = {}) {
    if (STATE.running) throw new Error('Autofill already running');
    STATE.running = true;
    STATE.stop = false;
    STATE.paused = false;
    let filled = 0;
    let skipped = 0;
    enterFillControls();
    startMagicOverlay();

    try {
      const form = findApplicationForm();
      if (!form) throw new Error('Greenhouse application form not found');

      let profile = options.profile;
      if (!profile) {
        const res = await chrome.runtime.sendMessage({
          type: 'greenhouseGetProfile',
          platform: 'greenhouse'
        });
        if (!res?.success || !res.profile) {
          throw new Error(res?.error || 'Profile not found — add JSON to System Prompt in Sai popup');
        }
        profile = res.profile;
      }

      await checkStop();
      setMagicStatus('Profile…');
      const b1 = await fillBlock1(profile);
      filled += b1.filled;
      skipped += b1.skipped;

      // Remaining fields: profile JSON only (no API)
      await checkStop();
      setMagicStatus('Employment…');
      const emp = await fillEmployment(profile);
      filled += emp.filled;
      skipped += emp.skipped;

      await checkStop();
      setMagicStatus('Education…');
      const edu = await fillEducation(profile);
      filled += edu.filled;
      skipped += edu.skipped;

      await checkStop();
      setMagicStatus('Profile questions…');
      const profileJobs = [];
      await collectBlock2AiJobs(profile, profileJobs);
      await collectConsentAiJobs(profile, profileJobs);
      await collectDemographicAiJobs(profile, profileJobs);
      await collectUnknownFormAiJobs(profile, profileJobs);

      await checkStop();
      setMagicStatus('Applying profile answers…');
      const answers = buildProfileOnlyAnswers(profileJobs, profile);
      const applied = await applyAiJobs(profileJobs, answers);
      filled += applied.filled;
      skipped += applied.skipped;

      await checkStop();
      setMagicStatus('EEOC…');
      const eeoc = await fillEeoc(profile);
      filled += eeoc.filled;
      skipped += eeoc.skipped;

      return { filled, skipped, stopped: STATE.stop, profileOnly: true };
    } finally {
      STATE.running = false;
      STATE.paused = false;
      stopMagicOverlay(true);
      exitFillControls({ restoreOffer: true });
    }
  }

  function buildSharedAiContext(profile) {
    const jdSnippet = (getJobDescription() || '').slice(0, 1200);
    const facts = [
      profile.firstName || profile.lastName
        ? `Candidate: ${[profile.firstName, profile.lastName].filter(Boolean).join(' ')}`
        : '',
      profile.age ? `Age: ${profile.age}` : '',
      profile.birthday ? `Birthday: ${profile.birthday}` : '',
      profile.gender ? `Gender: ${profile.gender}` : '',
      profile.city || profile.state
        ? `Location: ${[profile.city, profile.state, profile.country].filter(Boolean).join(', ')}`
        : '',
      profile.race ? `Race/ethnicity: ${profile.race}` : '',
      profile.hispanicLatino ? `Hispanic/Latino: ${profile.hispanicLatino}` : '',
      profile.veteranStatus ? `Veteran status: ${profile.veteranStatus}` : '',
      profile.disabilityStatus ? `Disability: ${profile.disabilityStatus}` : '',
      profile.workAuth ? `Work authorization: ${profile.workAuth}` : '',
      profile.sponsorship ? `Needs sponsorship: ${profile.sponsorship}` : '',
      Array.isArray(profile.employment) && profile.employment.length
        ? `Employment: ${profile.employment
            .slice(0, 5)
            .map((e) => `${e.title} at ${e.company}`)
            .join('; ')}`
        : '',
      Array.isArray(profile.education) && profile.education.length
        ? `Education: ${profile.education
            .slice(0, 3)
            .map((e) => `${e.degree || ''} ${e.field || ''} @ ${e.school || ''}`.trim())
            .join('; ')}`
        : '',
      profile.profileSummary ? `Summary: ${JSON.stringify(profile.profileSummary).slice(0, 400)}` : '',
      jdSnippet ? `Job description excerpt:\n${jdSnippet}` : ''
    ];
    return facts.filter(Boolean).join('\n');
  }

  async function checkStop() {
    if (STATE.stop) throw new Error('Autofill stopped');
    while (STATE.paused) {
      await sleep(150);
      if (STATE.stop) throw new Error('Autofill stopped');
    }
  }

  // ── Block 1: static profile (no AI) ────────────────────────────────────
  async function fillBlock1(profile) {
    let filled = 0;
    let skipped = 0;
    const preferred =
      profileTextValue(profile.preferredName) || profileTextValue(profile.firstName);

    const textFields = [
      ['#first_name', profileTextValue(profile.firstName)],
      ['#last_name', profileTextValue(profile.lastName)],
      ['#preferred_name', preferred],
      ['#email', profileTextValue(profile.email)],
      ['#job_application_linkedin_profile', profileTextValue(profile.linkedin)],
      ['#job_application_website', profileTextValue(profile.website)]
    ];

    for (const [sel, value] of textFields) {
      await checkStop();
      if (!value) {
        skipped++;
        continue;
      }
      if (sel === '#email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        skipped++;
        continue;
      }
      const el = document.querySelector(sel);
      if (!el || !isEmpty(el)) {
        skipped++;
        continue;
      }
      await fillTextLike(el, value);
      filled++;
      await sleep(120);
    }

    // Country phone code — open menu, click option (no AI)
    if (profile.country) {
      await checkStop();
      const country = document.querySelector('#country');
      if (country && isEmpty(country)) {
        const ok = await fillReactSelect(country, profile.country, { mode: 'menu' });
        if (ok) filled++;
        else skipped++;
        await sleep(200);
      }
    }

    // Phone number
    if (profileTextValue(profile.phone)) {
      await checkStop();
      const phoneEl =
        document.querySelector('#phone') ||
        document.querySelector('.phone-input__phone input') ||
        document.querySelector('fieldset.phone-input input[type="tel"]');
      if (phoneEl && isEmpty(phoneEl)) {
        await fillTextLike(phoneEl, profileTextValue(profile.phone));
        filled++;
        await sleep(120);
      } else {
        skipped++;
      }
    }

    // Location (City) — must TYPE to load suggestions, then click match
    if (profile.city) {
      await checkStop();
      const loc =
        document.querySelector('#candidate-location') ||
        document.querySelector('input[id*="candidate-location"]');
      if (loc && isEmpty(loc)) {
        const ok = await fillReactSelect(loc, profile.city, { mode: 'typeahead' });
        if (ok) filled++;
        else skipped++;
        await sleep(200);
      }
    }

    return { filled, skipped };
  }

  // ── Employment (profile only, no AI) ──────────────────────────────────
  async function fillEmployment(profile) {
    let filled = 0;
    let skipped = 0;
    const root = getEmploymentRoot();
    const entries = Array.isArray(profile.employment) ? profile.employment : [];
    if (!root || !entries.length) return { filled, skipped };

    for (let i = 0; i < entries.length; i++) {
      await checkStop();
      if (i > 0) {
        const addBtn = root.querySelector('button.add-another-button, button[class*="add-another"]');
        if (addBtn) {
          addBtn.click();
          await sleep(400);
        }
      }
      const r = await fillEmploymentEntry(root, i, entries[i]);
      filled += r.filled;
      skipped += r.skipped;
    }
    return { filled, skipped };
  }

  async function fillEmploymentEntry(root, i, entry) {
    let filled = 0;
    let skipped = 0;

    const resolve = (id) =>
      document.getElementById(id) ||
      root.querySelector(`#${CSS.escape(id)}`) ||
      document.querySelector(`#${CSS.escape(id)}`);

    const company = entry.company || '';
    const title = entry.title || '';
    const startMonth = entry.startMonth || '';
    const startYear = entry.startYear || '';
    const endMonth = entry.endMonth || '';
    const endYear = entry.endYear || '';
    const isCurrent = !!entry.current;

    const textFields = [
      [`company-name-${i}`, company],
      [`title-${i}`, title],
      [`start-date-year-${i}`, startYear]
    ];
    if (!isCurrent) {
      textFields.push([`end-date-year-${i}`, endYear]);
    }

    for (const [id, value] of textFields) {
      await checkStop();
      if (!value) {
        skipped++;
        continue;
      }
      const el = resolve(id);
      if (!el || !isEmpty(el)) {
        skipped++;
        continue;
      }
      await fillTextLike(el, value);
      filled++;
      await sleep(120);
    }

    {
      await checkStop();
      if (!startMonth) {
        skipped++;
      } else {
        const el = resolve(`start-date-month-${i}`);
        if (!el || !isEmpty(el)) {
          skipped++;
        } else {
          const ok = await fillReactSelect(el, startMonth, { mode: 'menu' });
          if (ok) filled++;
          else skipped++;
          await sleep(150);
        }
      }
    }

    if (isCurrent) {
      await checkStop();
      const box =
        resolve(`current-role-${i}_1`) ||
        root.querySelector(`#current-role-${i} input[type="checkbox"]`) ||
        root.querySelector(`input[name="current-role-${i}"]`);
      if (box && !box.checked) {
        await sparkleAt(box);
        box.click();
        box.dispatchEvent(new Event('change', { bubbles: true }));
        filled++;
        await sleep(150);
      } else if (!box) {
        skipped++;
      } else {
        skipped++;
      }
    } else if (endMonth) {
      await checkStop();
      const el = resolve(`end-date-month-${i}`);
      if (!el || !isEmpty(el)) {
        skipped++;
      } else {
        const ok = await fillReactSelect(el, endMonth, { mode: 'menu' });
        if (ok) filled++;
        else skipped++;
        await sleep(150);
      }
    } else {
      skipped++;
    }

    return { filled, skipped };
  }

  // ── Education ─────────────────────────────────────────────────────────
  async function fillEducation(profile) {
    let filled = 0;
    let skipped = 0;
    const root = getEducationRoot();
    const entries = Array.isArray(profile.education) ? profile.education : [];
    if (!root || !entries.length) return { filled, skipped };

    for (let i = 0; i < entries.length; i++) {
      await checkStop();
      if (i > 0) {
        const addBtn = root.querySelector('button.add-another-button, button[class*="add-another"]');
        if (addBtn) {
          addBtn.click();
          await sleep(400);
        }
      }
      const entry = entries[i];
      const r = await fillEducationEntry(root, i, entry);
      filled += r.filled;
      skipped += r.skipped;
    }
    return { filled, skipped };
  }

  async function fillEducationEntry(root, i, entry) {
    let filled = 0;
    let skipped = 0;

    const resolve = (sel) =>
      document.querySelector(sel) ||
      root.querySelector(sel) ||
      findLabeledControl(root, labelRegexForEdu(sel));

    // School — type short keyword, click suggestion matching full school name
    {
      await checkStop();
      const el = resolve(`#school--${i}`);
      const full = entry.school || '';
      const typeText = entry.schoolSearch || full;
      if (!el || !typeText) {
        skipped++;
      } else if (!isEmpty(el)) {
        skipped++;
      } else {
        const ok = await fillReactSelect(el, full || typeText, {
          mode: 'typeahead',
          typeText,
          matchText: full || typeText
        });
        if (ok) filled++;
        else skipped++;
        await sleep(200);
      }
    }

    // Degree — profile only (pick closest option, no API)
    {
      await checkStop();
      const el = resolve(`#degree--${i}`);
      if (!el) {
        skipped++;
      } else if (!isEmpty(el)) {
        skipped++;
      } else {
        const preferred = entry.degree || '';
        if (!preferred) {
          skipped++;
        } else {
          const opts = await peekSelectOptions(el);
          const chosen = pickBest(opts, preferred) || preferred;
          const ok = await applyDegreeAnswer(el, chosen, preferred);
          if (ok) filled++;
          else skipped++;
          await sleep(200);
        }
      }
    }

    // Major / discipline — type short keyword, click matching suggestion
    {
      await checkStop();
      const el = resolve(`#discipline--${i}`);
      const full = entry.field || entry.discipline || '';
      const typeText = entry.fieldSearch || full;
      if (!el || !typeText) {
        skipped++;
      } else if (!isEmpty(el)) {
        skipped++;
      } else {
        const ok = await fillReactSelect(el, full || typeText, {
          mode: 'typeahead',
          typeText,
          matchText: full || typeText
        });
        if (ok) filled++;
        else skipped++;
        await sleep(200);
      }
    }

    // Months / years
    const rest = [
      [`#start-month--${i}`, entry.startMonth || 'September', true],
      [`#start-year--${i}`, entry.startYear, false],
      [`#end-month--${i}`, entry.endMonth || 'May', true],
      [`#end-year--${i}`, entry.endYear, false]
    ];

    for (const [sel, value, isSelect] of rest) {
      await checkStop();
      if (!value) {
        skipped++;
        continue;
      }
      const el = resolve(sel);
      if (!el || !isEmpty(el)) {
        skipped++;
        continue;
      }
      if (isSelect || el.getAttribute('role') === 'combobox') {
        const ok = await fillReactSelect(el, String(value), { mode: 'menu' });
        if (ok) filled++;
        else skipped++;
      } else {
        await fillTextLike(el, String(value));
        filled++;
      }
      await sleep(150);
    }

    return { filled, skipped };
  }

  async function peekSelectOptions(el) {
    if (!el) return [];
    try {
      await openReactSelect(el);
      await sleep(200);
      const opts = await collectSelectOptions(2500);
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      document.body.click();
      await sleep(120);
      return opts;
    } catch (_) {
      return [];
    }
  }

  async function applyDegreeAnswer(el, chosen, preferredDegree) {
    if (!el) return false;
    let answer = String(chosen || preferredDegree || '').trim();
    if (!answer) return false;

    await openReactSelect(el);
    await sleep(200);
    let nodes = await waitForSelectOptionNodes(2500);
    if (!nodes.length) {
      await openReactSelect(el);
      await sleep(200);
      nodes = await waitForSelectOptionNodes(2000);
    }
    const labels = nodes.map((n) => (n.textContent || '').replace(/\s+/g, ' ').trim());
    const best = pickBest(labels, answer) || pickBest(labels, preferredDegree) || answer;
    const node =
      nodes.find((n) => (n.textContent || '').replace(/\s+/g, ' ').trim() === best) ||
      nodes.find((n) => {
        const t = (n.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const b = best.toLowerCase();
        return t === b || t.includes(b) || b.includes(t);
      });
    if (node) {
      await clickSelectOption(node);
      await sleep(200);
      return true;
    }
    return fillReactSelect(el, best, { mode: 'menu' });
  }

  function labelRegexForEdu(sel) {
    if (/school/i.test(sel)) return /school/i;
    if (/degree/i.test(sel)) return /degree/i;
    if (/discipline|field/i.test(sel)) return /discipline|field of study|major/i;
    if (/start-month/i.test(sel)) return /start.*month/i;
    if (/start-year/i.test(sel)) return /start.*year/i;
    if (/end-month/i.test(sel)) return /end.*month/i;
    if (/end-year/i.test(sel)) return /end.*year/i;
    return /./;
  }

  // ── Block 2 + consents: collect for ONE batch AI call ─────────────────
  async function collectBlock2AiJobs(profile, aiJobs) {
    const { block2 } = getQuestionBlocks();
    if (!block2) return;

    const fields = collectFields(block2);
    let idx = 0;
    for (const field of fields) {
      await checkStop();
      if (!isFieldEmpty(field)) continue;
      // Classic EEOC widgets (#gender etc.) — profile fill later
      if (isStandardEeocField(field)) continue;

      let selectOptions = field.options || [];
      let inputType = 'text';
      if (field.kind === 'textarea') inputType = 'textarea';
      else if (field.kind === 'checkbox' || field.kind === 'checkbox-group') inputType = 'checkbox';
      else if (field.kind === 'react-select' || field.kind === 'select') {
        inputType = 'select-one';
        if (!selectOptions.length && field.el) {
          selectOptions = await peekSelectOptions(field.el);
        }
      }

      const fromProfile = matchProfileAnswer(field.label, profile);
      aiJobs.push({
        id: `b2-${idx++}`,
        applyKind: 'field',
        field,
        labelText:
          inputType === 'checkbox'
            ? `${field.label || 'Checkbox'} — reply yes or no (check this box?)`
            : field.label || 'Question',
        inputType,
        selectOptions,
        hint: fromProfile ? `Profile suggestion: ${fromProfile}` : ''
      });
    }
  }

  async function collectConsentAiJobs(profile, aiJobs) {
    const form = findApplicationForm() || document;
    const boxes = [...form.querySelectorAll('input[type="checkbox"]')].filter(
      (b) => !b.disabled && b.offsetParent !== null
    );
    let idx = 0;
    const seen = new Set(aiJobs.filter((j) => j.field?.el).map((j) => j.field.el));

    for (const box of boxes) {
      await checkStop();
      if (box.checked) continue;
      if (seen.has(box)) continue;

      const label = labelFor(box);
      const idName = `${box.id || ''} ${box.name || ''}`;
      const looksConsent =
        isConsentLabel(label) ||
        /gdpr|consent|agree|privacy|processing/i.test(idName) ||
        box.required ||
        box.getAttribute('aria-required') === 'true';
      if (!looksConsent) continue;

      const field = {
        el: box,
        label: label || idName || 'Consent checkbox',
        kind: 'checkbox',
        inputs: [box]
      };
      seen.add(box);
      aiJobs.push({
        id: `consent-${idx++}`,
        applyKind: 'field',
        field,
        labelText: `${field.label} — reply yes or no (check this box?)`,
        inputType: 'checkbox',
        selectOptions: [],
        hint:
          box.required || box.getAttribute('aria-required') === 'true'
            ? 'Required to submit the application; prefer yes if appropriate.'
            : 'Consent/agreement checkbox.'
      });
    }
  }

  function profileTextValue(value) {
    if (value == null || value === '') return '';
    if (typeof value === 'boolean') return '';
    const s = String(value).trim();
    if (!s || /^false$/i.test(s) || /^true$/i.test(s)) return '';
    return s;
  }

  function profileCheckboxValue(value) {
    if (value == null || value === '') return '';
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    return String(value).trim();
  }

  function lookupScreeningAnswer(label, profile, inputType = 'text') {
    const screening = profile.screeningQuestions;
    if (!screening || typeof screening !== 'object') return '';

    const t = String(label || '').toLowerCase().replace(/\*/g, '').trim();
    if (t.length < 3) return '';

    const blockedKeys = new Set([
      'name', 'first', 'last', 'mail', 'email', 'phone', 'tel', 'mobile',
      'city', 'state', 'country', 'address', 'yes', 'no', 'true', 'false'
    ]);

    for (const [key, value] of Object.entries(screening)) {
      if (value == null || value === '') continue;
      const k = String(key).toLowerCase().replace(/[_-]/g, ' ').trim();
      if (k.length < 4) continue;
      if (blockedKeys.has(k)) continue;

      const tNorm = t.replace(/[\s_-]/g, '');
      const kNorm = k.replace(/[\s_-]/g, '');
      const match =
        t === k ||
        tNorm === kNorm ||
        (k.length >= 8 && t.includes(k)) ||
        (t.length >= 8 && k.includes(t));

      if (!match) continue;

      if (inputType === 'checkbox') return profileCheckboxValue(value);
      if (typeof value === 'boolean') continue;
      return profileTextValue(value);
    }
    return '';
  }

  function buildProfileOnlyAnswers(jobs, profile) {
    const answers = {};
    for (const job of jobs) {
      if (job.applyKind === 'degree') {
        const chosen =
          pickBest(job.selectOptions || [], job.preferredDegree) || job.preferredDegree || '';
        if (chosen) answers[job.id] = chosen;
        continue;
      }
      if (job.applyKind !== 'field' || !job.field) continue;

      let ans =
        matchProfileAnswer(job.field.label, profile) ||
        lookupScreeningAnswer(job.field.label, profile, job.inputType) ||
        profileTextValue(job.hint) ||
        '';

      if (!ans && job.inputType === 'checkbox') {
        const box = job.field.inputs?.[0] || job.field.el;
        if (box?.required || box?.getAttribute?.('aria-required') === 'true') {
          ans = 'yes';
        } else if (isConsentLabel(job.field.label)) {
          ans = 'yes';
        }
      }

      if (ans) answers[job.id] = String(ans).trim();
    }
    return answers;
  }

  // askAiBatch removed — autofill uses buildProfileOnlyAnswers (no API)

  async function applyAiJobs(aiJobs, answers) {
    let filled = 0;
    let skipped = 0;
    const { block1 } = getQuestionBlocks();
    for (const job of aiJobs) {
      await checkStop();
      const answer = String(answers[job.id] || '').trim();
      try {
        if (job.applyKind === 'degree') {
          const chosen =
            answer ||
            pickBest(job.selectOptions || [], job.preferredDegree) ||
            job.preferredDegree ||
            '';
          if (!chosen) {
            skipped++;
            continue;
          }
          if (job.el && !isEmpty(job.el)) {
            skipped++;
            continue;
          }
          const ok = await applyDegreeAnswer(job.el, chosen, job.preferredDegree);
          if (ok) filled++;
          else skipped++;
        } else if (job.applyKind === 'field' && job.field) {
          const el = job.field.el;
          // Never re-touch profile block after the initial profile pass
          if (block1 && el && block1.contains(el)) {
            skipped++;
            continue;
          }
          if (isKnownStaticField(job.field)) {
            skipped++;
            continue;
          }
          if (!isFieldEmpty(job.field)) {
            skipped++;
            continue;
          }
          let use = answer || job.hint || '';
          if (!use && job.inputType === 'checkbox') {
            const box = job.field.inputs?.[0] || job.field.el;
            if (box?.required || box?.getAttribute?.('aria-required') === 'true') use = 'yes';
            else if (isConsentLabel(job.field.label)) use = 'yes';
          }
          if (!use) {
            skipped++;
            continue;
          }
          const ok = await applyFieldAnswer(job.field, use);
          if (ok) filled++;
          else skipped++;
        } else {
          skipped++;
        }
      } catch (err) {
        console.warn(LOG, 'apply AI job failed', job.id, err);
        skipped++;
      }
      await sleep(160);
    }
    return { filled, skipped };
  }

  // ── Demographic + EEOC + unknown blocks ───────────────────────────────
  async function pushFieldAiJob(aiJobs, field, profile, idPrefix, idx) {
    let selectOptions = field.options || [];
    let inputType = 'text';
    if (field.kind === 'textarea') inputType = 'textarea';
    else if (field.kind === 'checkbox' || field.kind === 'checkbox-group') inputType = 'checkbox';
    else if (field.kind === 'react-select' || field.kind === 'select') {
      inputType = 'select-one';
      if (!selectOptions.length && field.el) {
        selectOptions = await peekSelectOptions(field.el);
      }
    }

    const fromProfile = matchProfileAnswer(field.label, profile);
    aiJobs.push({
      id: `${idPrefix}-${idx}`,
      applyKind: 'field',
      field,
      labelText:
        inputType === 'checkbox'
          ? `${field.label || 'Checkbox'} — reply yes or no (check this box?)`
          : field.label || 'Question',
      inputType,
      selectOptions,
      hint: fromProfile
        ? `Profile suggestion: ${fromProfile}. Pick the closest option from the list — do not invent values.`
        : 'Use candidate profile context. Pick the closest option from the list — do not invent values. Prefer decline/prefer not to say when unsure on sensitive topics.'
    });
  }

  /** Voluntary Self Identification / custom demographic selects → always AI. */
  async function collectDemographicAiJobs(profile, aiJobs) {
    const root = getDemographicRoot();
    if (!root) return;

    const seen = aiJobElementSet(aiJobs);
    let idx = 0;
    const fields = collectFields(root);
    for (const field of fields) {
      await checkStop();
      if (!isFieldEmpty(field)) continue;
      if (field.el && seen.has(field.el)) continue;
      // Only skip classic Greenhouse EEOC widgets (#gender etc.) — not custom wording
      if (isStandardEeocField(field) && isInsideStandardEeocContainer(field.el)) continue;

      if (field.el) seen.add(field.el);
      await pushFieldAiJob(aiJobs, field, profile, 'demo', idx++);
    }
  }

  /**
   * Safety net: remaining empty fields in unknown blocks.
   * Never re-touches block 1 (profile), employment, or education.
   */
  async function collectUnknownFormAiJobs(profile, aiJobs) {
    const form = findApplicationForm();
    if (!form) return;

    const { block1 } = getQuestionBlocks();
    const skipRoots = [
      block1,
      getEmploymentRoot(),
      getEducationRoot(),
      getDemographicRoot() // already queued via collectDemographicAiJobs
    ].filter(Boolean);
    const seen = aiJobElementSet(aiJobs);
    let idx = 0;

    const fields = collectFields(form);
    for (const field of fields) {
      await checkStop();
      if (!field?.el) continue;
      if (!isFieldEmpty(field)) continue;
      if (seen.has(field.el)) continue;
      if (skipRoots.some((r) => r.contains(field.el))) continue;
      if (isKnownStaticField(field)) continue;
      if (isStandardEeocField(field) && isInsideStandardEeocContainer(field.el)) continue;
      if (field.el.type === 'file' || field.el.type === 'hidden') continue;

      seen.add(field.el);
      await pushFieldAiJob(aiJobs, field, profile, 'unk', idx++);
    }
  }

  function aiJobElementSet(aiJobs) {
    const seen = new Set();
    for (const j of aiJobs) {
      if (j.el) seen.add(j.el);
      if (j.field?.el) seen.add(j.field.el);
      (j.field?.inputs || []).forEach((el) => seen.add(el));
    }
    return seen;
  }

  function isKnownStaticField(field) {
    const id = String(field.el?.id || field.el?.name || '');
    return /^(first_name|last_name|preferred_name|email|phone|country|candidate-location|job_application_location|job_application_linkedin|job_application_website|company-name-|title-|start-date-|end-date-|current-role-|school--|degree--|discipline--|start-month--|end-month--|start-year--|end-year--)/i.test(
      id
    );
  }

  function isInsideStandardEeocContainer(el) {
    if (!el) return false;
    return !!el.closest('.eeoc_container, .eeoc__container, [class*="eeoc_"], [class*="eeoc-"]');
  }

  function isStandardEeocField(field) {
    const id = String(field.el?.id || '');
    // Classic Greenhouse EEOC control IDs only
    if (/^(gender|hispanic_ethnicity|race|veteran_status|disability_status)$/i.test(id)) {
      return true;
    }
    // Do NOT treat custom Voluntary Self Identification questions as standard EEOC
    // (e.g. "racial/ethnic background", "veteran or active member") — those must use AI.
    return false;
  }

  async function fillDemographic(profile) {
    const profileJobs = [];
    await collectDemographicAiJobs(profile, profileJobs);
    if (!profileJobs.length) return { filled: 0, skipped: 0 };
    const answers = buildProfileOnlyAnswers(profileJobs, profile);
    return applyAiJobs(profileJobs, answers);
  }

  async function fillEeoc(profile) {
    const root = getEeocRoot();
    if (!root) return { filled: 0, skipped: 0 };
    // Custom Voluntary Self Identification lives in #demographic-section — AI only.
    // Do not profile-fill when this "eeoc" root is actually that demographic block.
    if (root.id === 'demographic-section' || root.classList?.contains('demographic--container')) {
      return { filled: 0, skipped: 0 };
    }

    let filled = 0;
    let skipped = 0;

    // Direct IDs from Greenhouse EEOC DOM — profile only, never AI
    const steps = [
      ['#gender', profile.gender || 'Male'],
      ['#hispanic_ethnicity', profile.hispanicLatino || 'No'],
      ['#race', profile.race || 'Two or More Races'],
      ['#veteran_status', profile.veteranStatus || 'I am not a protected veteran'],
      ['#disability_status', profile.disabilityStatus || 'No']
    ];

    for (const [sel, value] of steps) {
      await checkStop();
      // Strictly inside EEOC root — never document-wide (avoids touching demo / profile)
      let control = root.querySelector(sel);

      if (!control && sel === '#race') {
        const start = Date.now();
        while (!control && Date.now() - start < 8000) {
          await checkStop();
          control = root.querySelector(sel);
          if (control) break;
          await sleep(250);
        }
      }
      if (!control) {
        const labelRe =
          sel === '#gender'
            ? /^gender$/i
            : sel === '#hispanic_ethnicity'
              ? /hispanic or latino/i
              : sel === '#race'
                ? /^race$/i
                : sel === '#veteran_status'
                  ? /veteran status|protected veteran/i
                  : /disability status/i;
        control = findLabeledControl(root, labelRe);
      }
      if (!control || !root.contains(control)) {
        skipped++;
        continue;
      }
      if (!isEmpty(control)) {
        skipped++;
        continue;
      }
      const ok = await fillReactSelect(control, String(value), { mode: 'menu' });
      if (ok) filled++;
      else skipped++;
      await sleep(280);
    }
    return { filled, skipped };
  }

  async function waitForSelector(sel, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await checkStop();
      const el = document.querySelector(sel);
      if (el) return el;
      await sleep(250);
    }
    return null;
  }

  function ageRangeHint(age) {
    const n = Number(age);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 18) return 'Under 18';
    if (n <= 24) return '18-24';
    if (n <= 29) return '25-29';
    if (n <= 34) return '30-34';
    if (n <= 39) return '35-39';
    if (n <= 44) return '40-44';
    if (n <= 49) return '45-49';
    if (n <= 54) return '50-54';
    if (n <= 59) return '55-59';
    if (n <= 64) return '60-64';
    return '65+';
  }

  function matchProfileAnswer(label, profile) {
    const t = String(label || '').toLowerCase().replace(/\*/g, '').trim();

    if (/\bfirst[\s_-]?name\b|\bfname\b/.test(t)) return profileTextValue(profile.firstName);
    if (/\blast[\s_-]?name\b|\blname\b|\bsurname\b/.test(t)) return profileTextValue(profile.lastName);
    if (/\bemail\b|\be[\s_-]?mail\b/.test(t)) return profileTextValue(profile.email);
    if (/\bphone\b|\bmobile\b|\btel\b/.test(t)) return profileTextValue(profile.phone);
    if (/\blinkedin\b/.test(t)) return profileTextValue(profile.linkedin);

    // Do NOT map plain gender onto transgender / sexual-orientation questions
    if (/transgender|sexual orientation|orientation do you/i.test(t)) return '';

    if (/\bgender identity\b|\bwhat gender\b|^gender$|\bsex\b/.test(t) && !/transgender|orientation/.test(t)) {
      return profileTextValue(profile.gender);
    }
    if (/hispanic|latino/.test(t)) return profileTextValue(profile.hispanicLatino);
    if (/racial\/ethnic|racial or ethnic|race\/ethnicity|ethnic background|describe your race|\brace\b/.test(t)) {
      return profileTextValue(profile.race);
    }
    if (/veteran|armed forces/.test(t)) return profileTextValue(profile.veteranStatus);
    if (/disability|disabled|chronic condition/.test(t)) return profileTextValue(profile.disabilityStatus);
    if (/age range|what age|age do you|fall within/.test(t)) {
      return ageRangeHint(profile.age) || (profile.age ? String(profile.age) : '') || profile.birthday || '';
    }
    if (/what region|region do you|reside in|state of residence/.test(t)) {
      return profile.state || profile.city || profile.country || '';
    }
    if (/authorized to work|work authorization|legally authorized/.test(t)) {
      return profileTextValue(profile.workAuth) || 'Yes';
    }
    if (/sponsor|sponsorship|visa/.test(t)) {
      return profileTextValue(profile.sponsorship) || 'No';
    }
    if (/cover letter|additional information|anything else|comments|why do you want|tell us about yourself|about you/i.test(t)) {
      return profileTextValue(profile.profileSummary);
    }
    return '';
  }

  function isConfidentSelectMatch(option, desired) {
    const o = normSelectText(option);
    const w = normSelectText(desired);
    if (!o || !w) return false;
    if (o === w) return true;
    // Single-token desired must appear as its own token, not only inside a longer phrase like "trans man/male"
    const wTokens = w.split(' ').filter(Boolean);
    const oTokens = o.split(' ').filter(Boolean);
    if (wTokens.length === 1) {
      return oTokens.includes(wTokens[0]) && oTokens.length <= 2;
    }
    // Multi-word: require high overlap and matching negation
    const wantNot = /\bnot\b/.test(w);
    const optNot = /\bnot\b/.test(o);
    if (wantNot !== optNot) return false;
    const overlap = wTokens.filter((t) => oTokens.includes(t)).length;
    return overlap >= Math.ceil(wTokens.length * 0.6);
  }

  function isDemographicLabel(label) {
    return /gender|hispanic|latino|race|ethnicity|veteran|disability|eeoc|demographic|age range|region|sexual orientation|transgender/i.test(
      String(label || '')
    );
  }

  async function fillConsentCheckboxes(profile) {
    const profileJobs = [];
    await collectConsentAiJobs(profile, profileJobs);
    if (!profileJobs.length) return { filled: 0, skipped: 0 };
    const answers = buildProfileOnlyAnswers(profileJobs, profile);
    return applyAiJobs(profileJobs, answers);
  }

  // ── Field discovery ───────────────────────────────────────────────────
  function collectFields(root) {
    if (!root) return [];
    const fields = [];
    const wrappers = root.querySelectorAll(
      [
        '.field-wrapper',
        '.field-wrapper--multiline',
        '.text-input-wrapper',
        '.input-wrapper_multi-line',
        'fieldset.checkbox',
        'fieldset.phone-input',
        'div.select',
        'div.checkbox',
        'div.checkbox--full-width',
        '[class*="checkbox"]',
        '[class*="field"]'
      ].join(', ')
    );

    const seen = new Set();
    for (const wrap of wrappers) {
      const parsed = parseWrapper(wrap);
      if (!parsed) continue;
      const key =
        (parsed.inputs && parsed.inputs[0]?.id) ||
        parsed.el?.id ||
        parsed.label + parsed.kind;
      if (seen.has(key)) continue;
      seen.add(key);
      fields.push(parsed);
    }

    // Explicit pass for consent / GDPR checkboxes missed by wrappers
    root.querySelectorAll('input[type="checkbox"]').forEach((box) => {
      if (box.disabled) return;
      const key = box.id || box.name || labelFor(box);
      if (seen.has(key)) return;
      seen.add(key);
      fields.push({
        el: box,
        label: labelFor(box) || box.name || 'Checkbox',
        kind: 'checkbox',
        options: [],
        inputs: [box]
      });
    });

    if (!fields.length) {
      root.querySelectorAll('input, textarea, select').forEach((el) => {
        if (el.type === 'hidden' || el.type === 'file') return;
        fields.push({
          el,
          label: labelFor(el),
          kind: detectKind(el),
          options: []
        });
      });
    }
    return fields;
  }

  function parseWrapper(wrap) {
    const label = (
      wrap.querySelector('label')?.textContent ||
      wrap.querySelector('legend')?.textContent ||
      wrap.getAttribute('aria-label') ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim();

    const textarea = wrap.querySelector('textarea');
    if (textarea) return { el: textarea, label, kind: 'textarea', options: [] };

    const selectNative = wrap.querySelector('select');
    if (selectNative) {
      return {
        el: selectNative,
        label,
        kind: 'select',
        options: Array.from(selectNative.options).map((o) => o.textContent.trim()).filter(Boolean)
      };
    }

    const combo =
      wrap.querySelector('[role="combobox"]') ||
      wrap.querySelector('input[id*="react-select"]') ||
      wrap.querySelector('.select__input input') ||
      wrap.querySelector('input');
    if (combo && wrap.querySelector('.select, [class*="select"]')) {
      return { el: combo, label, kind: 'react-select', options: [] };
    }

    const checkboxes = wrap.querySelectorAll('input[type="checkbox"]');
    if (checkboxes.length) {
      const kind = checkboxes.length === 1 ? 'checkbox' : 'checkbox-group';
      return {
        el: checkboxes.length === 1 ? checkboxes[0] : wrap,
        label: label || labelFor(checkboxes[0]),
        kind,
        options: [],
        inputs: [...checkboxes]
      };
    }

    const radios = wrap.querySelectorAll('input[type="radio"]');
    if (radios.length) {
      return { el: wrap, label, kind: 'radio-group', options: [], inputs: [...radios] };
    }

    const input = wrap.querySelector('input:not([type="hidden"]):not([type="file"])');
    if (input) return { el: input, label, kind: 'text', options: [] };

    return null;
  }

  function detectKind(el) {
    if (!el) return 'text';
    if (el.tagName === 'TEXTAREA') return 'textarea';
    if (el.tagName === 'SELECT') return 'select';
    if (el.getAttribute?.('role') === 'combobox') return 'react-select';
    if (el.type === 'checkbox') return 'checkbox';
    if (el.type === 'radio') return 'radio';
    return 'text';
  }

  function labelFor(el) {
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) return lab.textContent.trim();
    }
    return (
      el.closest('label')?.textContent ||
      el.getAttribute('aria-label') ||
      el.placeholder ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim();
  }

  function findLabeledControl(root, re) {
    const labels = root.querySelectorAll('label, legend, .label, [class*="label"]');
    for (const lab of labels) {
      const text = (lab.textContent || '').trim();
      if (!re.test(text)) continue;
      if (lab.htmlFor) {
        const byId = document.getElementById(lab.htmlFor);
        if (byId) return byId;
      }
      const wrap = lab.closest('.field-wrapper, .select, fieldset, div') || lab.parentElement;
      const control =
        wrap?.querySelector('[role="combobox"], select, input, textarea') ||
        lab.parentElement?.querySelector('[role="combobox"], select, input, textarea');
      if (control) return control;
    }
    return null;
  }

  function findControlNearLabel() {
    return null;
  }

  async function waitForLabeledControl(root, re, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await checkStop();
      const el = findLabeledControl(root, re);
      if (el) return el;
      await sleep(250);
    }
    return null;
  }

  // ── Empty checks ──────────────────────────────────────────────────────
  function isEmpty(el) {
    if (!el) return true;
    if (el.tagName === 'SELECT') return !el.value;
    if (el.isContentEditable) return !(el.textContent || '').trim();
    const v = (el.value || '').trim();
    if (v) return false;
    // React-Select single value
    const wrap = el.closest('.select, [class*="select"]') || el.parentElement;
    const single = wrap?.querySelector('.select__single-value, [class*="singleValue"]');
    if (single && single.textContent.trim()) return false;
    const placeholder = wrap?.querySelector('.select__placeholder, [class*="placeholder"]');
    if (placeholder) return true;
    return true;
  }

  function isFieldEmpty(field) {
    if (!field) return true;
    if (field.kind === 'checkbox' || field.kind === 'checkbox-group' || field.kind === 'radio-group') {
      return !(field.inputs || [field.el]).some((i) => i && i.checked);
    }
    if (field.kind === 'react-select') return isEmpty(field.el);
    return isEmpty(field.el);
  }

  // ── Fill helpers ──────────────────────────────────────────────────────
  /**
   * Greenhouse React inputs ignore bulk value sets. Set the prefix, then
   * key-type the last 4 characters so validation / controlled state updates.
   */
  async function fillTextLike(el, value) {
    const text = String(value ?? '');
    if (!el) return;

    await sparkleAt(el);
    el.classList.add('jobbidhelper-filled', 'sai-gh-casting');
    setTimeout(() => el.classList.remove('jobbidhelper-filled', 'sai-gh-casting'), 900);

    el.scrollIntoView?.({ block: 'center', inline: 'nearest' });
    el.focus({ preventScroll: true });
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.click();
    await sleep(40);

    const tailLen = Math.min(4, text.length);
    const head = text.slice(0, Math.max(0, text.length - tailLen));
    const tail = text.slice(Math.max(0, text.length - tailLen));

    // Start from empty so React's value tracker sees a real change
    setNativeValue(el, '');
    el.dispatchEvent(
      new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward' })
    );
    await sleep(25);

    if (head) {
      setNativeValue(el, head);
      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          data: head,
          inputType: 'insertText'
        })
      );
      await sleep(35);
    }

    for (const ch of tail) {
      await typeChar(el, ch);
    }

    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    el.blur();
  }

  function setNativeValue(element, value) {
    const previous = element.value;
    const proto =
      element.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(element, value);
    else element.value = value;

    // Tell React the previous value so the next input event is accepted
    const tracker = element._valueTracker;
    if (tracker) tracker.setValue(previous);
  }

  async function typeChar(element, ch) {
    const key = ch;
    const isPrintable = ch.length === 1;
    const code =
      isPrintable && /[a-zA-Z]/.test(ch)
        ? `Key${ch.toUpperCase()}`
        : isPrintable && /[0-9]/.test(ch)
          ? `Digit${ch}`
          : 'Unidentified';

    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        code,
        bubbles: true,
        cancelable: true,
        keyCode: ch.charCodeAt(0),
        which: ch.charCodeAt(0)
      })
    );
    element.dispatchEvent(
      new KeyboardEvent('keypress', {
        key,
        code,
        bubbles: true,
        cancelable: true,
        keyCode: ch.charCodeAt(0),
        which: ch.charCodeAt(0),
        charCode: ch.charCodeAt(0)
      })
    );

    setNativeValue(element, String(element.value || '') + ch);
    element.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        data: ch,
        inputType: 'insertText'
      })
    );
    element.dispatchEvent(
      new KeyboardEvent('keyup', {
        key,
        code,
        bubbles: true,
        cancelable: true,
        keyCode: ch.charCodeAt(0),
        which: ch.charCodeAt(0)
      })
    );
    await sleep(50);
  }

  /** @deprecated kept for callers; routes to fillTextLike typing path */
  async function typeTail(element, text) {
    await fillTextLike(element, text);
  }

  /**
   * Greenhouse React-Select:
   * - mode "menu": click open → click matching option (country, gender, EEOC…)
   * - mode "typeahead": type query → wait for suggestions → click match (location)
   */
  async function fillReactSelect(inputOrCombo, desired, options = {}) {
    const want = String(desired || '').trim();
    if (!want && !options.typeText) return false;
    const mode = options.mode || 'menu';
    const typeText = String(options.typeText || want).trim();
    const matchText = String(options.matchText || want || typeText).trim();

    let input = inputOrCombo;
    if (input && input.getAttribute('role') !== 'combobox' && input.tagName !== 'INPUT') {
      input = input.querySelector?.('[role="combobox"], input') || input;
    }
    if (!input) return false;

    if (input.tagName === 'SELECT') {
      const opts = [...input.options];
      const match = pickBest(
        opts.map((o) => o.textContent.trim()),
        matchText
      );
      if (!match) return false;
      const opt = opts.find((o) => o.textContent.trim() === match);
      if (!opt) return false;
      opt.selected = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    input.scrollIntoView?.({ block: 'center', inline: 'nearest' });
    await sparkleAt(input);
    await openReactSelect(input);
    await sleep(180);

    if (mode === 'typeahead') {
      setNativeValue(input, '');
      input.dispatchEvent(
        new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward' })
      );
      await sleep(40);
      for (const ch of typeText) {
        await typeChar(input, ch);
      }
      await sleep(550);
    }

    let nodes = await waitForSelectOptionNodes(mode === 'typeahead' ? 4500 : 2500);
    if (!nodes.length) {
      await openReactSelect(input);
      await sleep(200);
      if (mode === 'typeahead') {
        for (const ch of typeText.slice(-Math.min(4, typeText.length))) {
          await typeChar(input, ch);
        }
        await sleep(450);
      }
      nodes = await waitForSelectOptionNodes(mode === 'typeahead' ? 3500 : 2000);
    }

    const labels = nodes.map((n) => (n.textContent || '').replace(/\s+/g, ' ').trim());
    const best =
      pickBest(labels, matchText) ||
      pickBest(labels, typeText) ||
      (mode === 'typeahead' && labels[0]) ||
      '';
    if (!best) {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await sleep(150);
      return !isEmpty(input);
    }

    const node = nodes.find((n) => (n.textContent || '').replace(/\s+/g, ' ').trim() === best);
    if (node) {
      await clickSelectOption(node);
    } else {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    }
    await sleep(220);
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await sleep(80);
    return !isEmpty(input) || !!best;
  }

  async function openReactSelect(input) {
    const shell =
      input.closest('.select-shell, .select__container, .select, [class*="select"]') ||
      input.parentElement;
    const control =
      shell?.querySelector('.select__control') ||
      shell?.querySelector('[class*="control"]') ||
      input;
    const toggle =
      shell?.querySelector('button[aria-label="Toggle flyout"]') ||
      shell?.querySelector('.select__indicators button');

    control.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    control.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    control.click();
    if (toggle) {
      toggle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      toggle.click();
    }
    input.focus({ preventScroll: true });
    input.click();
    // ArrowDown helps some react-select menus open
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true, cancelable: true })
    );
  }

  async function clickSelectOption(node) {
    node.scrollIntoView?.({ block: 'nearest' });
    node.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window })
    );
    node.dispatchEvent(
      new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window })
    );
    node.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, button: 0 })
    );
    node.dispatchEvent(
      new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, button: 0 })
    );
    node.click();
  }

  function listSelectOptionNodes() {
    const nodes = [
      ...document.querySelectorAll('[id*="react-select"][id*="option"]'),
      ...document.querySelectorAll('[role="option"]'),
      ...document.querySelectorAll('.select__option'),
      ...document.querySelectorAll('[class*="option"]')
    ];
    // Dedupe + drop empty / "no options"
    const seen = new Set();
    const out = [];
    for (const n of nodes) {
      if (seen.has(n)) continue;
      seen.add(n);
      const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t || /^no options$/i.test(t)) continue;
      // Ignore intl-tel country list when filling react-select (different widget)
      if (n.closest('.iti__country-list')) continue;
      out.push(n);
    }
    return out;
  }

  async function waitForSelectOptionNodes(timeoutMs) {
    const start = Date.now();
    let found = [];
    while (Date.now() - start < timeoutMs) {
      found = listSelectOptionNodes();
      if (found.length) return found;
      await sleep(120);
    }
    return found;
  }

  async function collectSelectOptions(timeoutMs) {
    const nodes = await waitForSelectOptionNodes(timeoutMs);
    return [...new Set(nodes.map((n) => (n.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean))];
  }

  function normSelectText(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[^\w\s+/]/g, ' ')
      .replace(/[+/]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function pickBest(options, desired) {
    const want = normSelectText(desired);
    if (!want || !options?.length) return '';
    const wantTokens = want.split(' ').filter(Boolean);
    const wantHasNot = /\bnot\b/.test(want);

    let best = '';
    let bestScore = -1;
    for (const opt of options) {
      const o = normSelectText(opt);
      if (!o) continue;
      const oTokens = o.split(' ').filter(Boolean);
      const optHasNot = /\bnot\b/.test(o);
      let score = 0;

      if (o === want) {
        score = 1000;
      } else if (wantTokens.length === 1 && oTokens.length === 1 && oTokens[0] === wantTokens[0]) {
        score = 950;
      } else if (wantTokens.length === 1 && oTokens.includes(wantTokens[0])) {
        // "Male" must not prefer "Trans Man/Male" over "Man/Male"
        score = oTokens.length <= 2 ? 700 : 40;
      } else if (o.startsWith(want) || want.startsWith(o)) {
        score = Math.min(o.length, want.length) / Math.max(o.length, want.length) >= 0.7 ? 800 : 200;
      } else if (o.includes(want) && want.length >= 4) {
        score = 500;
      } else if (want.includes(o) && o.length >= 4) {
        // "I am not a veteran" contains "veteran" — penalize negation mismatch
        score = wantHasNot !== optHasNot ? 5 : 180;
      } else {
        const overlap = wantTokens.filter((w) =>
          oTokens.some((x) => x === w || (w.length > 3 && (x.includes(w) || w.includes(x))))
        ).length;
        score = overlap * 35;
        if (wantHasNot !== optHasNot) score = Math.min(score, 15);
      }

      // Prefer closer length when scores tie-ish
      if (score > 0) {
        const lenPenalty = Math.abs(o.length - want.length) / Math.max(o.length, want.length, 1);
        score = score * (1 - lenPenalty * 0.15);
      }

      if (score > bestScore) {
        bestScore = score;
        best = opt;
      }
    }
    return bestScore >= 100 ? best : '';
  }

  async function applyFieldAnswer(field, answer) {
    const text = String(answer || '').trim();
    if (!text) return false;

    if (field.kind === 'react-select' || field.kind === 'select') {
      return fillReactSelect(field.el, text);
    }
    if (field.kind === 'checkbox' || field.kind === 'checkbox-group') {
      return applyCheckboxAnswer(field, text);
    }
    if (field.kind === 'radio-group') {
      const labels = (field.inputs || []).map((b) => labelFor(b));
      const best = pickBest(labels, text);
      const idx = labels.indexOf(best);
      if (idx >= 0) {
        await sparkleAt(field.inputs[idx]);
        field.inputs[idx].click();
        return true;
      }
      return false;
    }
    await fillTextLike(field.el, text);
    return true;
  }

  function isAffirmative(text) {
    return /^(yes|y|true|1|agree|accept|check|checked|confirm|ok|okay)$/i.test(
      String(text || '').trim()
    );
  }

  function isNegative(text) {
    return /^(no|n|false|0|disagree|deny|uncheck|unchecked|decline)$/i.test(
      String(text || '').trim()
    );
  }

  function isConsentLabel(label) {
    return /gdpr|consent|agree|privacy|store and process|eligibility|data protection|terms|authorize|acknowledg/i.test(
      String(label || '')
    );
  }

  async function applyCheckboxAnswer(field, text) {
    const boxes = field.inputs || (field.el?.type === 'checkbox' ? [field.el] : []);
    if (!boxes.length) return false;

    const wantYes = isAffirmative(text);
    const wantNo = isNegative(text);
    const label = field.label || labelFor(boxes[0]) || '';

    // Single consent / GDPR checkbox — AI true/false
    if (boxes.length === 1) {
      const box = boxes[0];
      const shouldCheck =
        wantYes ||
        (!wantNo && isConsentLabel(label) && !/do not|don't|opt.?out/i.test(text));
      if (shouldCheck && !box.checked) {
        await sparkleAt(box);
        box.click();
        box.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      if (wantNo && box.checked) {
        box.click();
        box.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      // Already in desired state
      if (shouldCheck && box.checked) return true;
      if (wantNo && !box.checked) return true;
      return false;
    }

    // Multi-checkbox group: match option label or check on yes for agree-like options
    for (const box of boxes) {
      const lab = labelFor(box).toLowerCase();
      const should =
        lab.includes(text.toLowerCase()) ||
        (wantYes && /yes|agree|authorize|consent/.test(lab)) ||
        text.toLowerCase().includes(lab.slice(0, 12));
      if (should && !box.checked) {
        await sparkleAt(box);
        box.click();
        return true;
      }
    }
    const labels = boxes.map((b) => labelFor(b));
    const best = pickBest(labels, text);
    const idx = labels.indexOf(best);
    if (idx >= 0) {
      await sparkleAt(boxes[idx]);
      boxes[idx].click();
      return true;
    }
    return false;
  }

  async function askAi(field, context) {
    const selectOptions =
      field.kind === 'react-select'
        ? await (async () => {
            field.el.click();
            await sleep(200);
            const opts = await collectSelectOptions(1800);
            document.body.click();
            return opts;
          })()
        : field.options || [];

    const inputType =
      field.kind === 'textarea'
        ? 'textarea'
        : field.kind === 'checkbox' || field.kind === 'checkbox-group'
          ? 'checkbox'
          : field.kind === 'react-select' || field.kind === 'select'
            ? 'select-one'
            : 'text';

    const labelText =
      field.kind === 'checkbox' || field.kind === 'checkbox-group'
        ? `${field.label || 'Checkbox'} — reply only yes or no (whether to check this box)`
        : field.label || 'Question';

    const response = await chrome.runtime.sendMessage({
      type: 'getAICompletion',
      data: {
        labelText,
        inputType,
        selectOptions,
        context
      }
    });
    if (!response?.success) throw new Error(response?.error || 'AI failed');
    return String(response.data || '').trim();
  }

  // ── Magic autofill animation ──────────────────────────────────────────
  function ensureMagicStyles() {
    if (document.getElementById('sai-gh-magic-style')) return;
    const style = document.createElement('style');
    style.id = 'sai-gh-magic-style';
    style.textContent = `
      #sai-gh-magic {
        position: fixed !important;
        inset: 0 !important;
        z-index: 2147483645 !important;
        pointer-events: none !important;
        overflow: hidden !important;
      }
      #sai-gh-magic .sai-gh-magic-veil {
        position: absolute !important;
        inset: 0 !important;
        background:
          radial-gradient(ellipse 80% 50% at 80% 12%, rgba(0,229,255,0.12), transparent 55%),
          radial-gradient(ellipse 60% 40% at 20% 80%, rgba(37,99,235,0.1), transparent 50%);
        animation: sai-gh-veil-breathe 3.2s ease-in-out infinite !important;
      }
      #sai-gh-magic .sai-gh-magic-hud {
        position: absolute !important;
        top: 78px !important;
        right: var(--sai-float-right, 24px) !important;
        display: flex !important;
        align-items: center !important;
        gap: 10px !important;
        padding: 8px 14px 8px 10px !important;
        border-radius: 999px !important;
        background: rgba(255,255,255,0.92) !important;
        border: 1px solid rgba(0,229,255,0.35) !important;
        box-shadow: 0 10px 28px rgba(15,23,42,0.14), 0 0 24px rgba(0,229,255,0.2) !important;
        font: 650 12px/1.2 "Segoe UI", system-ui, sans-serif !important;
        color: #0f172a !important;
        backdrop-filter: blur(10px) !important;
      }
      #sai-gh-magic .sai-gh-magic-orb {
        width: 22px !important; height: 22px !important; border-radius: 50% !important;
        background: radial-gradient(circle at 35% 30%, #fff, #67e8f9 40%, #2563eb 100%) !important;
        box-shadow: 0 0 16px rgba(0,229,255,0.7) !important;
        animation: sai-gh-orb-spin 1.6s linear infinite !important;
        position: relative !important;
      }
      #sai-gh-magic .sai-gh-magic-orb::after {
        content: "" !important; position: absolute !important; inset: -4px !important;
        border-radius: 50% !important; border: 2px solid transparent !important;
        border-top-color: rgba(0,229,255,0.8) !important;
        animation: sai-gh-orb-spin 0.9s linear infinite reverse !important;
      }
      #sai-gh-magic.sai-gh-magic--out {
        animation: sai-gh-fade-out 0.45s ease forwards !important;
      }
      .sai-gh-spark {
        position: fixed !important;
        width: 6px !important; height: 6px !important;
        border-radius: 50% !important;
        background: #67e8f9 !important;
        box-shadow: 0 0 10px #22d3ee, 0 0 18px rgba(37,99,235,0.6) !important;
        pointer-events: none !important;
        z-index: 2147483647 !important;
        animation: sai-gh-spark-fly 0.75s ease-out forwards !important;
      }
      .sai-gh-cast-ring {
        position: fixed !important;
        border: 2px solid rgba(0,229,255,0.55) !important;
        border-radius: 12px !important;
        pointer-events: none !important;
        z-index: 2147483646 !important;
        box-shadow: 0 0 0 4px rgba(37,99,235,0.12), 0 0 28px rgba(0,229,255,0.35) !important;
        animation: sai-gh-ring-pulse 0.7s ease-out forwards !important;
      }
      .sai-gh-casting {
        outline: 2px solid rgba(0,229,255,0.45) !important;
        outline-offset: 3px !important;
        transition: outline-color 0.2s !important;
        box-shadow: 0 0 0 4px rgba(0,229,255,0.12) !important;
      }
      @keyframes sai-gh-veil-breathe {
        0%, 100% { opacity: 0.55; }
        50% { opacity: 1; }
      }
      @keyframes sai-gh-orb-spin { to { transform: rotate(360deg); } }
      @keyframes sai-gh-fade-out {
        to { opacity: 0; }
      }
      @keyframes sai-gh-spark-fly {
        0% { opacity: 1; transform: translate(0,0) scale(1); }
        100% { opacity: 0; transform: translate(var(--sx), var(--sy)) scale(0.2); }
      }
      @keyframes sai-gh-ring-pulse {
        0% { opacity: 0.9; transform: scale(0.96); }
        100% { opacity: 0; transform: scale(1.04); }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function startMagicOverlay() {
    ensureMagicStyles();
    document.getElementById('sai-gh-magic')?.remove();
    const root = document.createElement('div');
    root.id = 'sai-gh-magic';
    root.innerHTML = `
      <div class="sai-gh-magic-veil"></div>
      <div class="sai-gh-magic-hud">
        <span class="sai-gh-magic-orb" aria-hidden="true"></span>
        <span class="sai-gh-magic-status">Sai is casting autofill…</span>
      </div>
    `;
    (document.body || document.documentElement).appendChild(root);
  }

  function setMagicStatus(text) {
    const el = document.querySelector('#sai-gh-magic .sai-gh-magic-status');
    if (el) el.textContent = text || 'Sai is casting autofill…';
  }

  function stopMagicOverlay(celebrate) {
    const root = document.getElementById('sai-gh-magic');
    if (!root) return;
    if (celebrate) {
      const status = root.querySelector('.sai-gh-magic-status');
      if (status) status.textContent = 'Done ✨';
      // Burst from center-right
      const x = window.innerWidth - 80;
      const y = 110;
      for (let i = 0; i < 14; i++) spawnSpark(x, y);
    }
    root.classList.add('sai-gh-magic--out');
    setTimeout(() => root.remove(), 480);
  }

  function spawnSpark(x, y) {
    const s = document.createElement('span');
    s.className = 'sai-gh-spark';
    const angle = Math.random() * Math.PI * 2;
    const dist = 28 + Math.random() * 56;
    s.style.left = `${x}px`;
    s.style.top = `${y}px`;
    s.style.setProperty('--sx', `${Math.cos(angle) * dist}px`);
    s.style.setProperty('--sy', `${Math.sin(angle) * dist}px`);
    document.body.appendChild(s);
    setTimeout(() => s.remove(), 780);
  }

  async function sparkleAt(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return;
    try {
      el.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    } catch (_) {}
    await sleep(60);
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return;

    const ring = document.createElement('div');
    ring.className = 'sai-gh-cast-ring';
    ring.style.left = `${r.left - 6}px`;
    ring.style.top = `${r.top - 6}px`;
    ring.style.width = `${r.width + 12}px`;
    ring.style.height = `${r.height + 12}px`;
    document.body.appendChild(ring);
    setTimeout(() => ring.remove(), 720);

    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    for (let i = 0; i < 8; i++) spawnSpark(cx, cy);
    await sleep(40);
  }

  // ── Toast + utils ─────────────────────────────────────────────────────
  function toast(message, type = 'info') {
    const existing = document.getElementById('sai-gh-toast');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.id = 'sai-gh-toast';
    el.className = `sai-gh-toast sai-gh-toast--${type}`;
    el.textContent = message;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('sai-gh-toast-show'));
    setTimeout(() => {
      el.classList.remove('sai-gh-toast-show');
      setTimeout(() => el.remove(), 280);
    }, 2600);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
})();
