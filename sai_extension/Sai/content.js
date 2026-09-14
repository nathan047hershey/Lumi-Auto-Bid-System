// content.js - Content script for DOM detection and field filling

(function() {
  'use strict';

  if (window.__jobBidHelperLoaded) return;
  window.__jobBidHelperLoaded = true;

  console.log('[JobBidHelper] Content script loaded');

  const SAI_UI_SELECTORS = [
    '#sai-greenhouse-offer',
    '#sai-greenhouse-offer-fallback',
    '#jobbidhelper-dock',
    '#sai-gh-magic',
    '#jobbidhelper-toast',
    '#sai-gh-toast'
  ];

  function isSaiUiElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    return SAI_UI_SELECTORS.some((sel) => el.matches?.(sel) || el.closest?.(sel));
  }

  function getLayoutRoot() {
    try {
      if (window.top?.document?.documentElement) {
        return { doc: window.top.document, win: window.top };
      }
    } catch (_) {}
    return { doc: document, win: window };
  }

  /** Detect Simplify and other fixed right-side extension panels. */
  function measureRightSidebarInset() {
    const { doc, win } = getLayoutRoot();
    const vw = win.innerWidth;
    const vh = win.innerHeight;
    if (vw < 480) return 0;

    let maxInset = 0;
    const sampleYs = [96, Math.floor(vh * 0.35), Math.floor(vh * 0.55), Math.floor(vh * 0.78)];

    for (const y of sampleYs) {
      let stack;
      try {
        stack = doc.elementsFromPoint(Math.max(0, vw - 2), y);
      } catch (_) {
        continue;
      }
      for (const el of stack) {
        if (isSaiUiElement(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 220 || rect.height < Math.min(260, vh * 0.3)) continue;
        if (rect.right < vw - 6) continue;
        if (rect.left > vw - rect.width - 16) continue;
        maxInset = Math.max(maxInset, Math.ceil(rect.width + 12));
      }
    }

    for (const el of doc.querySelectorAll('[class*="simplify" i], [id*="simplify" i], iframe[src*="simplify" i]')) {
      if (isSaiUiElement(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width >= 220 && rect.right >= vw - 6) {
        maxInset = Math.max(maxInset, Math.ceil(rect.width + 12));
      }
    }

    return Math.min(maxInset, Math.floor(vw * 0.55));
  }

  function bringSaiUiToFront() {
    for (const sel of SAI_UI_SELECTORS) {
      const el = document.querySelector(sel);
      if (el?.parentElement) el.parentElement.appendChild(el);
    }
  }

  function updateSaiLayoutOffset() {
    const inset = measureRightSidebarInset();
    const value = `${inset}px`;
    document.documentElement.style.setProperty('--sai-right-sidebar', value);
    try {
      window.top?.document?.documentElement?.style.setProperty('--sai-right-sidebar', value);
    } catch (_) {}
    bringSaiUiToFront();
  }

  function initSaiLayoutOffset() {
    updateSaiLayoutOffset();
    window.addEventListener('resize', updateSaiLayoutOffset, { passive: true });
    let debounce = null;
    const obs = new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(updateSaiLayoutOffset, 250);
    });
    const startObs = () => {
      if (document.body) obs.observe(document.body, { childList: true, subtree: false });
    };
    if (document.body) startObs();
    else document.addEventListener('DOMContentLoaded', startObs, { once: true });
    setInterval(updateSaiLayoutOffset, 2000);
  }

  window.__saiUpdateLayoutOffset = updateSaiLayoutOffset;
  try {
    window.top.__saiUpdateLayoutOffset = updateSaiLayoutOffset;
  } catch (_) {}
  initSaiLayoutOffset();

  // State
  let bindingMode = false;
  let pendingLabel = null;
  let bindings = {};

  // Load bindings from storage
  loadBindings();

  // Listen for Shift+Click to enter binding mode
  document.addEventListener('click', handleClick, true);

  // Load bindings from chrome.storage
  function loadBindings() {
    sendMessageWithRetry({ type: 'getSettings' })
      .then((settings) => {
        if (settings && settings.bindings) {
          bindings = settings.bindings;
        }
      })
      .catch(() => {});
  }

  // Prefix chord: press 1, then a second key within PREFIX_MS
  let hotkey1Pressed = false;
  let prefixTimer = null;
  const PREFIX_MS = 1500;

  const HOTKEYS = {
    '2': 'jdHandoff',
    '3': 'groqFill',
    '4': 'assistantFill',
    '5': 'profileAutofill'
  };

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('#jobbidhelper-dock')) return;
    if (e.key === '1') {
      hotkey1Pressed = true;
      clearTimeout(prefixTimer);
      prefixTimer = setTimeout(() => {
        hotkey1Pressed = false;
      }, PREFIX_MS);
      return;
    }
    if (hotkey1Pressed && HOTKEYS[e.key]) {
      e.preventDefault();
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'ping') {
      sendResponse({ success: true, pong: true });
      return;
    }

    const actions = {
      fillJdAndGenerate: () => fillJdAndGenerate(message.text),
      clickMarkApplied: clickMarkApplied,
      clickSaveResume: clickSaveResume,
      askAssistant: () => askAssistant(message.question),
      pollAssistantAnswer: () => pollAssistantAnswer(message.countBefore, message.question),
      probeJobList: probeJobList,
      getNextJobFromList: getNextJobFromList,
      clickNextJobLinks: clickNextJobLinks,
      advanceJobListMarker: advanceJobListMarker
    };
    const fn = actions[message.type];
    if (!fn) return;
    Promise.resolve(fn())
      .then((result) => sendResponse({ success: true, ...(result || {}) }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  });

  initJobDock();

  // Remove legacy Greenhouse "Fill" toolbar button if an older inject left it
  stripLegacyGreenhouseFillButton();
  setInterval(stripLegacyGreenhouseFillButton, 2000);

  function stripLegacyGreenhouseFillButton() {
    document.getElementById('sai-gh-dock-fill')?.remove();
    document.querySelectorAll('#jobbidhelper-dock .sai-toolbar button').forEach((btn) => {
      const t = (btn.textContent || '').trim();
      if (/^fill/i.test(t) || /^auto\s*fill/i.test(t)) btn.remove();
    });
  }

  // Greenhouse pages: ensure autofill module + always show offer bubble
  bootGreenhouseOfferDetection();

  function isGreenhouseHost() {
    const host = location.hostname.toLowerCase();
    return (
      host === 'boards.greenhouse.io' ||
      host === 'job-boards.greenhouse.io' ||
      host.endsWith('.greenhouse.io')
    );
  }

  /** Agency Hub / job list / resume builder — never show Greenhouse autofill offer. */
  function isAgencyPlatformPage() {
    if (document.getElementById('resume-job-description')) return true;
    if (/\/jobs\/[0-9a-f-]{36}\/apply/i.test(location.pathname)) return true;
    if (document.querySelector('tbody') && getJobListRows().length >= 1) return true;
    return false;
  }

  /** Greenhouse job boards only (not platform tabs or parent pages with GH iframes). */
  function looksLikeGreenhousePage() {
    if (isAgencyPlatformPage()) return false;
    return isGreenhouseHost();
  }

  function removeGreenhouseOfferUi() {
    document.getElementById('sai-greenhouse-offer-fallback')?.remove();
    document.getElementById('sai-greenhouse-offer')?.remove();
    document.getElementById('sai-gh-magic')?.remove();
    window.__saiGreenhouseOfferBooted = false;
  }

  function bootGreenhouseOfferDetection() {
    const tick = () => {
      if (!looksLikeGreenhousePage()) {
        removeGreenhouseOfferUi();
        return false;
      }
      removeGreenhouseOfferUi();
      maybeEnsureGreenhouseModule();
      updateDockForPage();
      return true;
    };
    if (tick()) return;
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      if (tick() || n > 60) clearInterval(timer);
    }, 500);
  }

  async function maybeEnsureGreenhouseModule() {
    if (!looksLikeGreenhousePage()) return;
    if (window.__saiGreenhouseEnsureRequested) return;
    window.__saiGreenhouseEnsureRequested = true;
    try {
      await sendMessageWithRetry({ type: 'ensureGreenhouseScript' });
    } catch (err) {
      window.__saiGreenhouseEnsureRequested = false;
      console.warn('[Sai] ensureGreenhouseScript failed', err);
    }
  }

  async function handleFixedProfileAutofill() {
    if (looksLikeGreenhousePage()) {
      return handleGreenhouseAutofill();
    }

    setSaiMood('working');
    showToast('Profile autofill…', 'info');
    try {
      const res = await sendMessageWithRetry({ type: 'greenhouseGetProfile', platform: 'greenhouse' });
      if (!res?.success || !res.profile) {
        throw new Error(res?.error || 'No profile — open Sai → Profile tab');
      }
      const { filled, skipped } = await fillGenericProfileFields(res.profile);
      setSaiMood('success', { holdMs: 3200 });
      showToast(`Filled ${filled} field${filled === 1 ? '' : 's'} from profile`, filled ? 'success' : 'info');
      if (!filled && skipped) {
        showToast('No empty matching fields found', 'info');
      }
    } catch (error) {
      setSaiMood('error', { holdMs: 3200 });
      showToast(error.message || 'Profile autofill failed', 'error');
      throw error;
    }
  }

  function isInputEmpty(input) {
    if (!input) return true;
    const type = getInputType(input);
    if (type === 'checkbox') return !input.checked;
    if (type === 'radio') {
      const group = document.querySelectorAll(`input[name="${CSS.escape(input.name)}"]`);
      return ![...group].some((r) => r.checked);
    }
    if (type === 'select-one' || type === 'select-multiple') {
      return ![...input.options].some((o) => o.selected && o.value);
    }
    if (input.isContentEditable) return !(input.textContent || '').trim();
    return !(input.value || '').trim();
  }

  function getFieldLabelText(input) {
    if (!input) return '';
    const parts = [];

    if (input.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (lab) parts.push(lab.textContent);
    }

    const ariaLabelledBy = input.getAttribute('aria-labelledby');
    if (ariaLabelledBy) {
      ariaLabelledBy.split(/\s+/).forEach((id) => {
        const el = document.getElementById(id);
        if (el) parts.push(el.textContent);
      });
    }

    parts.push(
      input.closest('label')?.textContent,
      input.getAttribute('aria-label'),
      input.placeholder,
      input.getAttribute('title')
    );

    const wrap = input.closest('.field, .form-group, .input-wrapper, [class*="field"], [class*="FormField"]');
    if (wrap && wrap.contains(input)) {
      const legend = wrap.querySelector('legend, label, [class*="label"]');
      if (legend && legend !== input && !input.contains(legend)) {
        parts.push(legend.textContent);
      }
    }

    return parts
      .filter(Boolean)
      .map((s) => String(s).replace(/\s+/g, ' ').trim())
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
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

    // Too ambiguous — these collide with First/Last Name, Email, etc.
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
      // Never put booleans into text/email fields
      if (typeof value === 'boolean') continue;
      return profileTextValue(value);
    }
    return '';
  }

  function matchGenericProfileValue(label, input, profile) {
    const idName = `${input?.id || ''} ${input?.name || ''} ${input?.autocomplete || ''}`.toLowerCase();
    const t = String(label || '').toLowerCase().replace(/\*/g, '').trim();
    const inputType = getInputType(input);

    const byField = [
      [/\bfirst[\s_-]?name\b|\bfname\b|\bgiven[\s_-]?name\b/, profile.firstName],
      [/\blast[\s_-]?name\b|\blname\b|\bsurname\b|\bfamily[\s_-]?name\b/, profile.lastName],
      [/\bpreferred[\s_-]?name\b|\bnickname\b/, profile.preferredName || profile.firstName],
      [/\bemail\b|\be[\s_-]?mail\b/, profile.email],
      [/\bphone\b|\btel\b|\bmobile\b|\bcell\b/, profile.phone],
      [/\blinkedin\b/, profile.linkedin],
      [/\bwebsite\b|\bportfolio\b|\bgithub\b/, profile.website],
      [/\bcity\b|\blocality\b/, profile.city],
      [/\bstate\b|\bprovince\b|\bregion\b/, profile.state],
      [/\bzip\b|\bpostal\b/, profile.zipCode],
      [/\bcountry\b/, profile.country]
    ];

    for (const [re, val] of byField) {
      const text = profileTextValue(val);
      if (text && (re.test(idName) || (t.length >= 2 && re.test(t)))) return text;
    }

    if (t.length >= 2) {
      if (/hispanic|latino/.test(t)) return profileTextValue(profile.hispanicLatino);
      if (/\bgender\b/.test(t) && !/transgender|orientation/.test(t)) return profileTextValue(profile.gender);
      if (/race|ethnic/.test(t)) return profileTextValue(profile.race);
      if (/veteran/.test(t)) return profileTextValue(profile.veteranStatus);
      if (/disability/.test(t)) return profileTextValue(profile.disabilityStatus);
      if (/authorized to work|work authorization|legally authorized/.test(t)) {
        return profileTextValue(profile.workAuth) || 'Yes';
      }
      if (/sponsor|sponsorship|visa/.test(t)) {
        return profileTextValue(profile.sponsorship) || 'No';
      }
      if (/cover letter|additional information|about you|tell us about|why do you/i.test(t)) {
        return profileTextValue(profile.profileSummary);
      }
    }

    return lookupScreeningAnswer(label, profile, inputType);
  }

  async function fillGenericProfileFields(profile) {
    let filled = 0;
    let skipped = 0;
    const seen = new Set();

    const candidates = document.querySelectorAll('input, textarea, select, [contenteditable="true"]');
    for (const input of candidates) {
      const inputType = getInputType(input);
      if (inputType === 'hidden' || input.type === 'file') continue;
      if (inputType === 'checkbox' || inputType === 'radio') continue;
      if (!isFillable(input)) continue;
      if (input.closest('#jobbidhelper-dock')) continue;

      const key = input.id || `${input.name}:${input.type}` || input;
      if (seen.has(key)) continue;
      seen.add(key);

      if (!isInputEmpty(input)) {
        skipped++;
        continue;
      }

      const label = getFieldLabelText(input);
      const value = matchGenericProfileValue(label, input, profile);
      if (!value) {
        skipped++;
        continue;
      }

      if (inputType === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        skipped++;
        continue;
      }

      try {
        await fillInput(input, value);
        filled++;
      } catch (_) {
        skipped++;
      }
    }
    return { filled, skipped };
  }

  async function handleGreenhouseAutofill() {
    setSaiMood('working');
    showToast('Starting autofill…', 'info');
    window.__saiGreenhouseFilling = true;
    try {
      await sendMessageWithRetry({ type: 'ensureGreenhouseScript' });
      const jd = getJobDescriptionFromPage();
      if (jd) {
        try {
          await sendMessageWithRetry({ type: 'tryJdHandoff', text: jd });
        } catch (_) {}
      }
      const res = await sendMessageWithRetry({
        type: 'greenhouseStartAutofill',
        platform: 'greenhouse'
      });
      if (!res?.success) throw new Error(res?.error || 'Autofill failed');
      setSaiMood('success', { holdMs: 3200 });
      showToast(`Filled ${res.filled || 0} fields`, 'success');
    } catch (error) {
      setSaiMood('error', { holdMs: 3200 });
      showToast(error.message || 'Autofill failed', 'error');
      throw error;
    } finally {
      window.__saiGreenhouseFilling = false;
    }
  }

  function updateDockForPage() {
    const dock = document.getElementById('jobbidhelper-dock');
    if (!dock) return;
    dock.querySelector('[data-action="greenhouseAutofill"]')?.classList.remove('sai-hidden');
  }

  document.addEventListener('keyup', (e) => {
    if (e.target.closest('#jobbidhelper-dock')) return;
    const action = HOTKEYS[e.key];
    if (!action) return;
    if (!hotkey1Pressed) return;
    hotkey1Pressed = false;
    clearTimeout(prefixTimer);

    if (action === 'profileAutofill') {
      e.preventDefault();
      handleFixedProfileAutofill().catch(() => {});
      return;
    }

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;

    const selectedText = selection.toString().trim();
    if (!selectedText) return;

    if (action === 'jdHandoff') {
      handleJdHandoff(selectedText);
    } else if (action === 'groqFill') {
      handleGroqFill(selectedText);
    } else if (action === 'assistantFill') {
      handleAssistantFill(selectedText);
    }
  });

  function getJobDescriptionFromPage() {
    const selectors = [
      '.job__description.body',
      '.job__description',
      '[class*="job__description"]',
      '[data-automation-id="jobPostingDescription"]',
      '.job-description',
      '#job-description',
      '[class*="job-description"]',
      '[class*="JobDescription"]'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      const text = (el?.innerText || el?.textContent || '').trim();
      if (text.length > 40) return text;
    }
    const selected = window.getSelection()?.toString().trim();
    if (selected && selected.length > 40) return selected;
    return '';
  }

  async function handleGenerateCv() {
    setSaiMood('working');
    showToast('Generating CV…', 'info');
    try {
      const jd = getJobDescriptionFromPage();
      if (!jd) {
        throw new Error('Job description not found — open the full posting or select the JD text');
      }
      try {
        await navigator.clipboard.writeText(jd);
      } catch (_) {}
      const response = await sendMessageWithRetry({ type: 'tryJdHandoff', text: jd });
      if (!response?.handoff) {
        throw new Error(response?.error || 'CV generation failed');
      }
      setSaiMood('success', { holdMs: 3200 });
      showToast('CV generating on platform tab', 'success');
    } catch (error) {
      setSaiMood('error', { holdMs: 3200 });
      showToast(error.message || 'CV generation failed', 'error');
      throw error;
    }
  }

  window.__saiGenerateCv = handleGenerateCv;

  async function handleJdHandoff(selectedText) {
    try {
      try {
        await navigator.clipboard.writeText(selectedText);
      } catch (_) {}

      const response = await sendMessageWithRetry({
        type: 'tryJdHandoff',
        text: selectedText
      });

      if (!response?.handoff) {
        throw new Error(response?.error || 'JD handoff failed');
      }

      showToast('JD copied and sent to platform — generating resume', 'success');
    } catch (error) {
      showToast(error.message || 'JD handoff failed', 'error');
    }
    clearSelection();
  }

  function handleGroqFill(selectedText) {
    const label = findLabelForSelection();
    if (!label) {
      getAIAnswerAndCopy(selectedText, null);
      clearSelection();
      return;
    }

    let input = findInputForLabel(label);

    const bindingKey = `${window.location.origin}:${selectedText}`;
    if (bindings[bindingKey]) {
      const boundInput = document.querySelector(bindings[bindingKey]);
      if (boundInput) {
        input = boundInput;
      }
    }

    if (input) {
      fillFieldWithAI(input, selectedText, label);
    } else {
      getAIAnswerAndCopy(selectedText, label);
    }

    clearSelection();
  }

  function findBoundOrNearestInput(selectedText) {
    const label = findLabelForSelection();
    let input = label ? findInputForLabel(label) : null;
    const bindingKey = `${window.location.origin}:${selectedText}`;
    if (bindings[bindingKey]) {
      const boundInput = document.querySelector(bindings[bindingKey]);
      if (boundInput) input = boundInput;
    }
    return input;
  }

  let __saiAnswerTarget = null;

  async function fetchMiniMaxAnswer(labelText, input) {
    const inputType = input ? getInputType(input) : 'text';
    const selectOptions = input ? getSelectOptions(input) : [];
    const context = input ? getContextForInput(input) : '';
    const response = await sendMessageWithRetry({
      type: 'getAICompletion',
      data: { labelText, inputType, selectOptions, context }
    });
    if (!response?.success) {
      throw new Error(response?.error || 'MiniMax request failed');
    }
    const answer = String(response.data || '').trim();
    if (!answer) throw new Error('MiniMax returned an empty answer');
    return answer;
  }

  function ensureAnswersPanel(dock) {
    if (!dock || dock.querySelector('#sai-answers')) return;
    const panel = document.createElement('div');
    panel.id = 'sai-answers';
    panel.className = 'sai-answers';
    panel.hidden = true;
    panel.innerHTML = `
      <div class="sai-answers-head">
        <span>Two answers — tap one to use</span>
        <button type="button" class="sai-answers-close" data-action="closeAnswers" title="Close" aria-label="Close answers">×</button>
      </div>
      <button type="button" class="sai-answer-card" data-answer-slot="platform" disabled>
        <span class="sai-answer-label">Platform</span>
        <span class="sai-answer-body">Waiting…</span>
      </button>
      <button type="button" class="sai-answer-card" data-answer-slot="minimax" disabled>
        <span class="sai-answer-label">MiniMax</span>
        <span class="sai-answer-body">Waiting…</span>
      </button>
    `;
    dock.appendChild(panel);
  }

  function setAnswerSlot(slot, { text = '', status = '', error = false } = {}) {
    const card = document.querySelector(`#sai-answers [data-answer-slot="${slot}"]`);
    if (!card) return;
    const body = card.querySelector('.sai-answer-body');
    const ready = !!text && !error;
    card.disabled = !ready;
    card.classList.toggle('sai-answer-card--error', !!error);
    card.classList.toggle('sai-answer-card--ready', ready);
    if (ready) card.setAttribute('data-answer', text);
    else card.removeAttribute('data-answer');
    if (body) body.textContent = text || status || 'Waiting…';
  }

  function showAnswersPanel() {
    const dock = document.getElementById('jobbidhelper-dock') || ensureDock({ showPlatformActions: false });
    if (!dock) return null;
    ensureAnswersPanel(dock);
    if (dock.classList.contains('sai-widget--minimized')) {
      setDockMinimized(dock, false);
      saveDockState(dock);
    }
    const panel = dock.querySelector('#sai-answers');
    if (panel) panel.hidden = false;
    return panel;
  }

  function hideAnswersPanel() {
    const panel = document.getElementById('sai-answers');
    if (panel) panel.hidden = true;
  }

  async function applyDockAnswer(text) {
    const answer = String(text || '').trim();
    if (!answer) return;
    try {
      await navigator.clipboard.writeText(answer);
    } catch (_) {}
    const input = __saiAnswerTarget && document.contains(__saiAnswerTarget) ? __saiAnswerTarget : null;
    if (input) {
      await fillInput(input, answer);
      showToast('Filled and copied', 'success');
    } else {
      showToast('Copied to clipboard', 'success');
    }
  }

  async function handleAssistantFill(selectedText) {
    const input = findBoundOrNearestInput(selectedText);
    __saiAnswerTarget = input || null;

    try {
      if (!document.getElementById('jobbidhelper-dock')) {
        ensureDock({ showPlatformActions: false });
      }
      showAnswersPanel();
      setAnswerSlot('platform', { status: 'Asking platform…' });
      setAnswerSlot('minimax', { status: 'Asking MiniMax…' });
      setSaiMood('working');
      showToast('Getting two answers…', 'info');

      const platformPromise = sendMessageWithRetry({
        type: 'askPlatformAssistant',
        question: selectedText
      }, 3).then((response) => {
        if (!response?.success || !response.answer) {
          throw new Error(response?.error || 'Platform answer is not ready yet');
        }
        return String(response.answer).trim();
      });

      const miniPromise = fetchMiniMaxAnswer(selectedText, input);

      const [platform, mini] = await Promise.allSettled([platformPromise, miniPromise]);

      const platformText = platform.status === 'fulfilled' ? platform.value : '';
      const miniText = mini.status === 'fulfilled' ? mini.value : '';

      if (platformText) setAnswerSlot('platform', { text: platformText });
      else setAnswerSlot('platform', { status: platform.reason?.message || 'Platform failed', error: true });

      if (miniText) setAnswerSlot('minimax', { text: miniText });
      else setAnswerSlot('minimax', { status: mini.reason?.message || 'MiniMax failed', error: true });

      if (platformText) {
        await applyDockAnswer(platformText);
      } else if (miniText) {
        await applyDockAnswer(miniText);
      } else {
        setSaiMood('error', { holdMs: 3200 });
        showToast(platform.reason?.message || mini.reason?.message || 'Both answers failed', 'error');
      }
    } catch (error) {
      setSaiMood('error', { holdMs: 3200 });
      showToast(error.message || 'Assistant failed', 'error');
    } finally {
      clearSelection();
    }
  }

  function setReactValue(element, value) {
    const proto = element.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) {
      setter.call(element, value);
    } else {
      element.value = value;
    }
    const tracker = element._valueTracker;
    if (tracker) tracker.setValue('');
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function fillJdAndGenerate(text) {
    const jd = (text || '').trim();
    if (!jd) throw new Error('No job description text');

    const textarea = document.getElementById('resume-job-description');
    if (!textarea) {
      throw new Error('JD field not found on this platform tab');
    }

    textarea.focus();
    setReactValue(textarea, jd);

    const form = textarea.closest('form');
    const generateBtn = form?.querySelector('button[type="submit"]')
      || Array.from(document.querySelectorAll('button')).find((btn) =>
        /generate resume/i.test(btn.textContent || '')
      );

    if (!generateBtn) {
      throw new Error('Generate resume button not found');
    }

    if (generateBtn.disabled) {
      throw new Error('Generate resume is disabled — select a profile first');
    }

    generateBtn.click();
    showToast('JD pasted — generating resume', 'success');
  }

  function isPlatformApplyPage() {
    return /\/jobs\/[0-9a-f-]{36}\/apply/i.test(location.pathname);
  }

  const JOB_ROW_DEFAULT_CLASS = 'border-l-slate-300 bg-slate-50/60 hover:bg-slate-50 dark:border-l-slate-600 dark:bg-slate-900/25 dark:hover:bg-slate-900/35';
  const JOB_ROW_MARKED_CLASS = 'border-l-slate-300 hover:bg-slate-50 dark:border-l-slate-600 dark:hover:bg-slate-900/35 ring-1 ring-inset ring-primary/35 bg-primary-muted/30 dark:bg-primary-muted/20';

  function isJobListPage() {
    return getJobListRows().length >= 1;
  }

  function probeJobList() {
    const rows = getJobListRows();
    return { isJobList: rows.length >= 1, rowCount: rows.length };
  }

  function getJobListRows() {
    const tbody = document.querySelector('tbody');
    if (!tbody) return [];
    return Array.from(tbody.querySelectorAll(':scope > tr')).filter((row) => findOpenLink(row));
  }

  function isMarkedJobRow(tr) {
    const cls = tr.className || '';
    return cls.includes('ring-primary') && cls.includes('primary-muted');
  }

  function isAppliedJobRow(tr) {
    const cls = tr.className || '';
    // Primary: emerald color class (platform's applied state)
    if (/border-l-emerald|bg-emerald/i.test(cls)) return true;

    // Secondary: select dropdown with 'applied' value
    const statusSelect = Array.from(tr.querySelectorAll('select')).find((select) =>
      Array.from(select.options).some((opt) => opt.value === 'applied')
    );
    if (statusSelect?.value === 'applied') return true;

    // Tertiary: scan all text content for "applied" indicators
    const text = (tr.textContent || '').toLowerCase();
    if (/applied|submitted|completed|done/i.test(text)) {
      // Make sure it's not just the word "Apply" in a link
      const links = Array.from(tr.querySelectorAll('a'));
      const hasAppliedLink = links.some(a => /^applied$/i.test((a.textContent || '').trim()));
      if (hasAppliedLink) return true;
    }

    return false;
  }

  function findResumeLink(tr) {
    return Array.from(tr.querySelectorAll('a')).find((a) => {
      const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
      return text === 'Resume' && /\/jobs\/[^/]+\/apply/i.test(a.getAttribute('href') || '');
    }) || null;
  }

  function findOpenLink(tr) {
    return Array.from(tr.querySelectorAll('a')).find((a) => {
      const href = a.getAttribute('href') || '';
      const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
      return /^Open/i.test(text) && /^https?:\/\//i.test(href);
    }) || null;
  }

  function findCurrentJobIndex(rows) {
    const markedIndex = rows.findIndex(isMarkedJobRow);
    if (markedIndex !== -1) return markedIndex;

    // Fallback: last applied (emerald) row — next New job follows it
    for (let i = rows.length - 1; i >= 0; i--) {
      if (isAppliedJobRow(rows[i])) return i;
    }
    return -1;
  }

  function findNextOpenableJob(rows, afterIndex) {
    for (let i = afterIndex + 1; i < rows.length; i++) {
      const row = rows[i];
      if (isAppliedJobRow(row)) continue;
      const resumeLink = findResumeLink(row);
      const openLink = findOpenLink(row);
      if (resumeLink && openLink) {
        return { row, index: i, resumeLink, openLink };
      }
    }
    return null;
  }

  function getNextJobFromList() {
    if (!isJobListPage()) {
      throw new Error('Job list table not found');
    }

    const rows = getJobListRows();
    const currentIndex = findCurrentJobIndex(rows);
    if (currentIndex === -1) {
      throw new Error('No marked or applied row — highlight the current job row on the list');
    }

    const next = findNextOpenableJob(rows, currentIndex);
    if (!next) {
      throw new Error('No next job on the list');
    }

    return {
      platformUrl: new URL(next.resumeLink.getAttribute('href'), location.origin).href,
      jobUrl: next.openLink.href,
      nextIndex: next.index
    };
  }

  /**
   * Fire a real click so the platform updates row styles, but block navigation.
   * Background opens tabs via chrome.tabs.create (reliable + immediate).
   */
  function clickAnchorForPlatformState(anchor) {
    if (!anchor) return;
    const blockNav = (e) => {
      e.preventDefault();
    };
    anchor.addEventListener('click', blockNav, true);
    try {
      anchor.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, view: window, button: 0
      }));
      anchor.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true, cancelable: true, view: window, button: 0
      }));
      anchor.click();
    } finally {
      anchor.removeEventListener('click', blockNav, true);
    }
  }

  function clickNextJobLinks() {
    if (!isJobListPage()) {
      throw new Error('Job list table not found');
    }

    const rows = getJobListRows();
    const currentIndex = findCurrentJobIndex(rows);
    if (currentIndex === -1) {
      throw new Error('No marked or applied row — highlight the current job row on the list');
    }

    const next = findNextOpenableJob(rows, currentIndex);
    if (!next) {
      throw new Error('No next job on the list');
    }

    const platformUrl = new URL(next.resumeLink.getAttribute('href'), location.origin).href;
    const jobUrl = next.openLink.href;

    // Notify platform of the selection (styles), without opening tabs from the page.
    clickAnchorForPlatformState(next.resumeLink);
    clickAnchorForPlatformState(next.openLink);

    return { platformUrl, jobUrl, nextIndex: next.index, clicked: true };
  }

  function advanceJobListMarker() {
    // Kept as a soft fallback; preferred path is clickNextJobLinks (platform owns styles).
    const rows = getJobListRows();
    const currentIndex = findCurrentJobIndex(rows);
    if (currentIndex === -1) return { advanced: false };

    const next = findNextOpenableJob(rows, currentIndex);
    if (!next) return { advanced: false };

    const current = rows[currentIndex];
    if (isMarkedJobRow(current)) {
      if (isAppliedJobRow(current)) {
        current.className = (current.className || '')
          .replace(/\bring-1\b/g, '')
          .replace(/\bring-inset\b/g, '')
          .replace(/\bring-primary\/35\b/g, '')
          .replace(/\bbg-primary-muted\/30\b/g, '')
          .replace(/\bdark:bg-primary-muted\/20\b/g, '')
          .replace(/\s+/g, ' ')
          .trim();
      } else {
        current.className = JOB_ROW_DEFAULT_CLASS;
      }
    }

    next.row.className = JOB_ROW_MARKED_CLASS;
    return { advanced: true };
  }

  function findMarkAppliedButton() {
    return Array.from(document.querySelectorAll('button')).find((btn) => {
      const text = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      return /^mark(\s+as)?\s+applied$/i.test(text) || /^mark applied$/i.test(text);
    }) || null;
  }

  function findSaveResumeButton() {
    return Array.from(document.querySelectorAll('button')).find((btn) => {
      const text = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      if (/^Save for\s+\S/i.test(text)) return true;
      return !!(btn.querySelector('.lucide-download') && /^Save for\b/i.test(text));
    });
  }

  function clickMarkApplied() {
    const btn = findMarkAppliedButton();
    if (!btn) throw new Error('Mark as applied button not found on the platform tab');
    if (btn.disabled) throw new Error('Mark as applied is disabled');
    btn.scrollIntoView?.({ block: 'center', inline: 'nearest' });
    btn.focus?.();
    // Use the same robust click sequence as platform anchor links
    const blockNav = (e) => { e.preventDefault(); };
    btn.addEventListener('click', blockNav, true);
    try {
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, button: 0 }));
      btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, button: 0 }));
      btn.click();
    } finally {
      btn.removeEventListener('click', blockNav, true);
    }
  }

  function clickSaveResume() {
    const btn = findSaveResumeButton();
    if (!btn || btn.disabled) {
      throw new Error('Resume is not ready yet');
    }
    btn.click();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function findAssistantInput() {
    return document.querySelector('textarea[placeholder*="Why this role"]')
      || document.querySelector('textarea[placeholder*="Draft answer"]')
      || Array.from(document.querySelectorAll('textarea')).find((el) =>
        /draft answer|why this role|application assistant/i.test(el.placeholder || '')
      )
      || null;
  }

  function findAssistantSendButton(textarea) {
    const form = textarea?.closest('form');
    return form?.querySelector('button[type="submit"]')
      || Array.from(document.querySelectorAll('button')).find((btn) => btn.querySelector('.lucide-send'))
      || null;
  }

  function findAssistantChatLog() {
    const input = findAssistantInput();
    if (input) {
      const panel = input.closest('.flex.h-full, .flex-col, form')?.parentElement
        || input.closest('[class*="rounded-xl"]');
      if (panel) {
        const log = Array.from(panel.querySelectorAll('div')).find((el) => {
          const cls = el.className || '';
          return cls.includes('overflow-y-auto')
            && cls.includes('space-y-4')
            && (cls.includes('min-h-[') || el.querySelector('p')?.textContent?.trim() === 'Assistant');
        });
        if (log) return log;
      }
    }

    return Array.from(document.querySelectorAll('div')).find((el) => {
      const cls = el.className || '';
      return cls.includes('overflow-y-auto')
        && cls.includes('space-y-4')
        && cls.includes('min-h-[300px]');
    }) || null;
  }

  function getAssistantMessageBlocks(chatLog) {
    if (!chatLog) return [];
    return Array.from(chatLog.children).filter((child) => {
      const label = child.querySelector(':scope > p');
      return label && /^Assistant$/i.test((label.textContent || '').trim());
    });
  }

  function extractAnswerFromBlock(block) {
    const copyBox = block.querySelector('[class*="border-primary"]');
    if (!copyBox) return '';

    const answerEl = copyBox.querySelector('p.whitespace-pre-wrap.text-sm.leading-relaxed.text-content')
      || copyBox.querySelector('div[class*="max-h"] p')
      || copyBox.querySelector('p.text-content');

    return (answerEl?.textContent || '').trim();
  }

  function getAssistantAnswerCount() {
    return getAssistantMessageBlocks(findAssistantChatLog()).length;
  }

  function findCopyAnswerButton(block) {
    if (!block) return null;
    return Array.from(block.querySelectorAll('button')).find((btn) => {
      const text = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      return /^Copy answer$/i.test(text) || !!btn.querySelector('.lucide-clipboard-copy');
    }) || null;
  }

  async function waitForEnabled(button, tries = 12) {
    for (let i = 0; i < tries; i++) {
      if (button && !button.disabled) return button;
      await sleep(150);
    }
    return button;
  }

  function pollAssistantAnswer(countBefore, question) {
    const blocks = getAssistantMessageBlocks(findAssistantChatLog());
    if (blocks.length <= countBefore) {
      return { answer: null, ready: false };
    }

    const last = blocks[blocks.length - 1];
    if (!findCopyAnswerButton(last)) {
      return { answer: null, ready: false };
    }

    const answer = extractAnswerFromBlock(last);
    if (!answer || answer === question) {
      return { answer: null, ready: false };
    }

    try {
      // Best-effort; job tab also copies when it receives the answer.
      navigator.clipboard.writeText(answer).catch(() => {});
    } catch (_) {}

    return { answer, ready: true };
  }

  async function askAssistant(question) {
    const q = (question || '').trim();
    if (!q) throw new Error('No question text');

    const textarea = findAssistantInput();
    if (!textarea) {
      throw new Error('Application assistant input not found');
    }

    const countBefore = getAssistantAnswerCount();
    setReactValue(textarea, q);

    const sendBtn = await waitForEnabled(findAssistantSendButton(textarea));
    if (!sendBtn) {
      throw new Error('Assistant send button not found');
    }
    if (sendBtn.disabled) {
      throw new Error('Assistant is inactive — paste the job description first');
    }

    sendBtn.click();

    // Return immediately; background waits 6s then polls up to 3 times.
    return { submitted: true, countBefore, question: q };
  }

  function initJobDock() {
    refreshDockVisibility();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshDockVisibility();
    });
    window.addEventListener('focus', refreshDockVisibility);
    setInterval(refreshDockVisibility, 4000);
  }

  let __saiPairedStreak = 0;

  async function refreshDockVisibility() {
    try {
      const res = await sendMessageWithRetry({ type: 'hasPairedPlatform' });
      const onGh = looksLikeGreenhousePage();
      const paired = !!res?.paired;

      if (paired) __saiPairedStreak = Math.min(3, __saiPairedStreak + 1);
      else __saiPairedStreak = Math.max(0, __saiPairedStreak - 1);

      // Keep platform buttons sticky once paired (avoids flicker every 4s)
      const showPlatform = paired || (__saiPairedStreak > 0 && !onGh);

      ensureDock({ showPlatformActions: showPlatform || paired });
      updateDockForPage();
    } catch (_) {
      if (!document.getElementById('jobbidhelper-dock')) {
        ensureDock({ showPlatformActions: false });
      }
    }
  }

  function removeDock() {
    document.getElementById('jobbidhelper-dock')?.remove();
    clearTimeout(window.__saiMoodTimer);
  }

  const SAI_STATE = {
    idle: { label: 'Online', dot: 'green', status: 'Your AI Assistant' },
    happy: { label: 'Online', dot: 'green', status: 'Happy to help!' },
    thinking: { label: 'Thinking', dot: 'orange', status: 'Thinking…' },
    working: { label: 'Typing', dot: 'purple', status: 'Working on it…' },
    success: { label: 'Online', dot: 'green', status: 'All done!' },
    error: { label: 'Away', dot: 'red', status: 'Something went wrong' },
    excited: { label: 'Online', dot: 'green', status: 'Let\'s go!' }
  };

  function renderSaiBot() {
    return `
      <div class="sai-bot-head">
        <div class="sai-ear sai-ear--l"><span class="sai-ear-glow"></span></div>
        <div class="sai-ear sai-ear--r"><span class="sai-ear-glow"></span></div>
        <div class="sai-visor">
          <svg class="sai-face-svg" viewBox="0 0 44 28" aria-hidden="true">
            <g class="sai-expr sai-expr--idle">
              <path d="M9 13 Q13 9 17 13" stroke="#00E5FF" stroke-width="2.2" fill="none" stroke-linecap="round"/>
              <path d="M27 13 Q31 9 35 13" stroke="#00E5FF" stroke-width="2.2" fill="none" stroke-linecap="round"/>
              <path d="M15 21 Q22 25 29 21" stroke="#00E5FF" stroke-width="2" fill="none" stroke-linecap="round"/>
            </g>
            <g class="sai-expr sai-expr--happy">
              <path d="M8 12 Q13 7 18 12" stroke="#00E5FF" stroke-width="2.4" fill="none" stroke-linecap="round"/>
              <path d="M26 12 Q31 7 36 12" stroke="#00E5FF" stroke-width="2.4" fill="none" stroke-linecap="round"/>
              <path d="M14 20 Q22 26 30 20" stroke="#00E5FF" stroke-width="2.2" fill="none" stroke-linecap="round"/>
            </g>
            <g class="sai-expr sai-expr--thinking">
              <ellipse cx="13" cy="12" rx="5" ry="3" fill="#00E5FF"/>
              <ellipse cx="31" cy="12" rx="5" ry="3" fill="#00E5FF"/>
              <path d="M18 22 H26" stroke="#00E5FF" stroke-width="2" stroke-linecap="round"/>
            </g>
            <g class="sai-expr sai-expr--sad">
              <path d="M9 11 Q13 15 17 11" stroke="#00E5FF" stroke-width="2.2" fill="none" stroke-linecap="round"/>
              <path d="M27 11 Q31 15 35 11" stroke="#00E5FF" stroke-width="2.2" fill="none" stroke-linecap="round"/>
              <path d="M15 23 Q22 19 29 23" stroke="#00E5FF" stroke-width="2" fill="none" stroke-linecap="round"/>
            </g>
            <g class="sai-expr sai-expr--excited">
              <path d="M10 11 L16 13 L10 15" stroke="#00E5FF" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M34 11 L28 13 L34 15" stroke="#00E5FF" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M17 18 Q22 24 27 18" stroke="#00E5FF" stroke-width="2.2" fill="#00E5FF" stroke-linecap="round"/>
            </g>
            <g class="sai-expr sai-expr--typing">
              <path d="M8 13 H18" stroke="#00E5FF" stroke-width="2.2" stroke-linecap="round"/>
              <path d="M26 13 H36" stroke="#00E5FF" stroke-width="2.2" stroke-linecap="round"/>
              <path d="M18 21 H26" stroke="#00E5FF" stroke-width="2" stroke-linecap="round"/>
            </g>
            <g class="sai-expr sai-expr--blink">
              <path d="M8 12 H18" stroke="#00E5FF" stroke-width="2.4" stroke-linecap="round"/>
              <path d="M26 12 H36" stroke="#00E5FF" stroke-width="2.4" stroke-linecap="round"/>
            </g>
          </svg>
          <div class="sai-waveform" aria-hidden="true">
            <span></span><span></span><span></span><span></span><span></span>
          </div>
        </div>
      </div>
    `;
  }

  function setSaiMood(mood, { holdMs = 0 } = {}) {
    const m = SAI_STATE[mood] ? mood : 'idle';
    document.querySelectorAll('.sai-bot').forEach((el) => {
      const sizes = Array.from(el.classList).filter((c) => c.startsWith('sai-bot--'));
      el.className = ['sai-bot', ...sizes, `sai-mood-${m}`].join(' ');
    });
    const state = SAI_STATE[m];
    const pill = document.querySelector('.sai-online-pill');
    if (pill) {
      pill.innerHTML = `<span class="sai-dot sai-dot--${state.dot}"></span>${state.label}`;
    }
    const subtitle = document.querySelector('.sai-subtitle');
    if (subtitle) subtitle.textContent = state.status;
    if (holdMs > 0) {
      clearTimeout(window.__saiMoodTimer);
      window.__saiMoodTimer = setTimeout(() => setSaiMood('idle'), holdMs);
    }
  }

  function ensureDock({ showPlatformActions = true } = {}) {
    let dock = document.getElementById('jobbidhelper-dock');
    if (!dock) {
      dock = document.createElement('div');
      dock.id = 'jobbidhelper-dock';
      dock.className = 'sai-widget';
      dock.innerHTML = `
      <div class="sai-toolbar">
        <button type="button" class="sai-drag-handle" data-sai-drag title="Drag to move" aria-label="Drag Sai">
          <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
            <circle cx="3" cy="3" r="1.4"/><circle cx="7" cy="3" r="1.4"/>
            <circle cx="3" cy="8" r="1.4"/><circle cx="7" cy="8" r="1.4"/>
            <circle cx="3" cy="13" r="1.4"/><circle cx="7" cy="13" r="1.4"/>
          </svg>
        </button>
        <div class="sai-bot sai-bot--fab sai-mood-idle" data-sai-bot title="Drag when minimized · double-click to minimize" role="img">${renderSaiBot()}<span class="sai-fab-dot"></span></div>
        <button type="button" class="sai-action-btn sai-action-btn--next" data-action="clickSkipToNext" title="Skip — open next job">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4v16l11-8z"/><path d="M19 5v14"/></svg>
        </button>
        <button type="button" class="sai-action-btn sai-action-btn--check" data-action="clickMarkApplied" title="Mark applied">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M20 6 9 17l-5-5"/></svg>
        </button>
        <div class="sai-more">
          <button type="button" class="sai-action-btn sai-action-btn--more" data-action="toggleMenu" title="More actions" aria-haspopup="menu" aria-expanded="false">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
            </svg>
          </button>
          <div class="sai-menu" role="menu" hidden>
            <button type="button" class="sai-menu-item sai-menu-item--fill" data-action="greenhouseAutofill" role="menuitem">
              <span class="sai-menu-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg></span>
              Autofill
            </button>
            <button type="button" class="sai-menu-item sai-menu-item--cv" data-action="generateCv" role="menuitem">
              <span class="sai-menu-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg></span>
              Generate CV
            </button>
            <button type="button" class="sai-menu-item sai-menu-item--save" data-action="clickSaveResume" role="menuitem">
              <span class="sai-menu-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg></span>
              Save resume
            </button>
            <button type="button" class="sai-menu-item sai-menu-item--min" data-action="toggleMinimize" role="menuitem">
              <span class="sai-menu-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h14"/></svg></span>
              Minimize
            </button>
          </div>
        </div>
      </div>
    `;
      dock.addEventListener('click', onDockClick);
      initDockInteraction(dock);
      document.documentElement.appendChild(dock);
      restoreDockState(dock);
    }
    ensureAnswersPanel(dock);

    dock.querySelectorAll('[data-action="clickSaveResume"], [data-action="clickSkipToNext"], [data-action="clickMarkApplied"]').forEach((btn) => {
      btn.classList.toggle('sai-hidden', !showPlatformActions);
    });

    window.__saiUpdateLayoutOffset?.();
    return dock;
  }

  const DOCK_STATE_KEY = 'saiDockUi';

  function clampDockPosition(left, top, dock) {
    const rect = dock.getBoundingClientRect();
    const w = Math.max(rect.width || 0, dock.classList.contains('sai-widget--minimized') ? 56 : 200);
    const h = Math.max(rect.height || 0, 56);
    const maxL = Math.max(8, window.innerWidth - w - 8);
    const maxT = Math.max(8, window.innerHeight - h - 8);
    return {
      left: Math.min(Math.max(8, left), maxL),
      top: Math.min(Math.max(8, top), maxT)
    };
  }

  function applyDockPosition(dock, left, top) {
    const pos = clampDockPosition(left, top, dock);
    dock.classList.add('sai-widget--placed');
    dock.style.left = `${pos.left}px`;
    dock.style.top = `${pos.top}px`;
    dock.style.right = 'auto';
    return pos;
  }

  function setDockMenuOpen(dock, open) {
    if (!dock) return;
    const menu = dock.querySelector('.sai-menu');
    const moreBtn = dock.querySelector('[data-action="toggleMenu"]');
    if (!menu || !moreBtn) return;
    const next = !!open;
    menu.hidden = !next;
    moreBtn.setAttribute('aria-expanded', next ? 'true' : 'false');
    dock.classList.toggle('sai-widget--menu-open', next);
  }

  function setDockMinimized(dock, minimized) {
    setDockMenuOpen(dock, false);
    dock.classList.toggle('sai-widget--minimized', !!minimized);
    const minItem = dock.querySelector('.sai-menu-item--min');
    if (minItem) {
      const label = minimized ? 'Expand' : 'Minimize';
      const icon = minimized
        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>'
        : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h14"/></svg>';
      minItem.innerHTML = `<span class="sai-menu-icon" aria-hidden="true">${icon}</span>${label}`;
    }
    if (dock.classList.contains('sai-widget--placed')) {
      requestAnimationFrame(() => {
        const left = parseFloat(dock.style.left) || 0;
        const top = parseFloat(dock.style.top) || 0;
        applyDockPosition(dock, left, top);
      });
    }
  }

  function saveDockState(dock) {
    const minimized = dock.classList.contains('sai-widget--minimized');
    const placed = dock.classList.contains('sai-widget--placed');
    const state = {
      minimized,
      placed,
      left: placed ? parseFloat(dock.style.left) || 0 : null,
      top: placed ? parseFloat(dock.style.top) || 0 : null
    };
    try {
      chrome.storage.local.set({ [DOCK_STATE_KEY]: state });
    } catch (_) {}
  }

  function restoreDockState(dock) {
    try {
      chrome.storage.local.get(DOCK_STATE_KEY, (data) => {
        const state = data?.[DOCK_STATE_KEY];
        if (!state) return;
        if (state.placed && Number.isFinite(state.left) && Number.isFinite(state.top)) {
          applyDockPosition(dock, state.left, state.top);
        }
        // Do not auto-restore minimized — next/complete must stay clickable after reload
      });
    } catch (_) {}
  }

  function initDockInteraction(dock) {
    if (dock.__saiInteractReady) return;
    dock.__saiInteractReady = true;

    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    let dragFromBot = false;

    const onPointerMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 6) return;
      moved = true;
      applyDockPosition(dock, originLeft + dx, originTop + dy);
    };

    const onPointerUp = (e) => {
      if (!dragging) return;
      dragging = false;
      dock.classList.remove('sai-widget--dragging');
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', onPointerUp, true);
      try {
        dock.releasePointerCapture?.(e.pointerId);
      } catch (_) {}

      if (dragFromBot && !moved && dock.classList.contains('sai-widget--minimized')) {
        toggleDockMinimized(dock);
      } else if (moved) {
        dock.__saiDidDrag = true;
        saveDockState(dock);
        setTimeout(() => { dock.__saiDidDrag = false; }, 120);
      }
      dragFromBot = false;
    };

    const beginDrag = (e, fromBot) => {
      if (e.button != null && e.button !== 0) return;
      const rect = dock.getBoundingClientRect();
      dragging = true;
      moved = false;
      dragFromBot = !!fromBot;
      startX = e.clientX;
      startY = e.clientY;
      originLeft = rect.left;
      originTop = rect.top;
      dock.classList.add('sai-widget--dragging');
      applyDockPosition(dock, originLeft, originTop);
      try {
        dock.setPointerCapture?.(e.pointerId);
      } catch (_) {}
      window.addEventListener('pointermove', onPointerMove, true);
      window.addEventListener('pointerup', onPointerUp, true);
      window.addEventListener('pointercancel', onPointerUp, true);
      e.preventDefault();
      e.stopPropagation();
    };

    dock.addEventListener('pointerdown', (e) => {
      // Never start drag from action / menu buttons
      if (e.target.closest('button.sai-action-btn, button[data-action], .sai-menu')) return;

      const handle = e.target.closest('[data-sai-drag]');
      const bot = e.target.closest('[data-sai-bot], .sai-bot--fab');
      if (handle) beginDrag(e, false);
      else if (bot && dock.classList.contains('sai-widget--minimized')) beginDrag(e, true);
    });

    if (!dock.__saiMenuOutsideBound) {
      dock.__saiMenuOutsideBound = true;
      document.addEventListener('pointerdown', (e) => {
        if (!dock.classList.contains('sai-widget--menu-open')) return;
        if (e.target.closest?.('#jobbidhelper-dock .sai-more')) return;
        setDockMenuOpen(dock, false);
      }, true);
    }

    dock.addEventListener('dblclick', (e) => {
      if (e.target.closest('[data-sai-bot], .sai-bot--fab') && !dock.classList.contains('sai-widget--minimized')) {
        e.preventDefault();
        e.stopPropagation();
        toggleDockMinimized(dock);
      }
    });

    window.addEventListener('resize', () => {
      if (!dock.classList.contains('sai-widget--placed')) return;
      const left = parseFloat(dock.style.left) || 0;
      const top = parseFloat(dock.style.top) || 0;
      applyDockPosition(dock, left, top);
    }, { passive: true });
  }

  function toggleDockMinimized(dock) {
    const next = !dock.classList.contains('sai-widget--minimized');
    setDockMinimized(dock, next);
    saveDockState(dock);
    if (!next) setSaiMood('happy', { holdMs: 1800 });
  }

  function formatChatTime(date = new Date()) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  async function onDockClick(event) {
    const dock = document.getElementById('jobbidhelper-dock');
    if (dock?.classList.contains('sai-widget--dragging') || dock?.__saiDidDrag) return;

    const answerCard = event.target.closest?.('[data-answer-slot]');
    if (answerCard && !event.target.closest('[data-action]')) {
      event.preventDefault();
      event.stopPropagation();
      const text = answerCard.getAttribute('data-answer') || '';
      if (!text) return;
      try {
        await applyDockAnswer(text);
      } catch (error) {
        showToast(error.message || 'Could not use that answer', 'error');
      }
      return;
    }

    const btn = event.target.closest('button[data-action]');
    if (!btn) return;

    event.preventDefault();
    event.stopPropagation();

    const action = btn.getAttribute('data-action');
    if (!action) return;

    if (action === 'toggleMenu') {
      if (!dock) return;
      const open = !dock.classList.contains('sai-widget--menu-open');
      setDockMenuOpen(dock, open);
      return;
    }

    if (action === 'toggleMinimize') {
      if (dock) toggleDockMinimized(dock);
      return;
    }

    if (action === 'closeAnswers') {
      hideAnswersPanel();
      return;
    }

    setDockMenuOpen(dock, false);

    if (dock?.classList.contains('sai-widget--minimized')) {
      setDockMinimized(dock, false);
      saveDockState(dock);
    }

    if (btn.disabled || dock?.__saiActionBusy) return;

    const platformActions = ['clickSaveResume', 'clickSkipToNext', 'clickMarkApplied'];
    if (platformActions.includes(action) && btn.classList.contains('sai-hidden')) {
      showToast('Put Agency Hub apply tab immediately left of this job tab', 'error');
      return;
    }

    btn.disabled = true;
    if (dock) dock.__saiActionBusy = true;

    if (action === 'generateCv') {
      try {
        await handleGenerateCv();
      } catch (_) {
      } finally {
        btn.disabled = false;
        if (dock) dock.__saiActionBusy = false;
      }
      return;
    }

    if (action === 'greenhouseAutofill') {
      try {
        await handleFixedProfileAutofill();
      } catch (_) {
      } finally {
        btn.disabled = false;
        if (dock) dock.__saiActionBusy = false;
      }
      return;
    }

    setSaiMood('working');
    try {
      const response = await sendMessageWithRetry({
        type: 'clickPlatformAction',
        action
      }, 3);
      if (!response?.success) {
        throw new Error(response?.error || 'Platform action failed');
      }
      if (action === 'clickMarkApplied') {
        if (response.nextJobOpened) {
          setSaiMood('excited', { holdMs: 3200 });
          showToast('Marked applied — next job opened', 'success');
        } else if (response.nextJobWarning) {
          setSaiMood('error', { holdMs: 3200 });
          showToast(`Marked applied. ${response.nextJobWarning}`, 'error');
        } else {
          setSaiMood('success', { holdMs: 3200 });
          showToast('Marked as applied on platform', 'success');
        }
      } else if (action === 'clickSkipToNext') {
        setSaiMood('excited', { holdMs: 3200 });
        showToast('Skipped — next job opened', 'success');
      } else {
        setSaiMood('happy', { holdMs: 3200 });
        showToast('Resume saved to your PC', 'success');
      }
    } catch (error) {
      setSaiMood('error', { holdMs: 3200 });
      showToast(error.message || 'Platform action failed', 'error');
    } finally {
      btn.disabled = false;
      if (dock) dock.__saiActionBusy = false;
    }
  }

  function getChatLog() {
    return document.getElementById('jobbidhelper-chat-log');
  }

  function clearChatEmpty(log) {
    log?.querySelector('.sai-welcome')?.classList.remove('sai-welcome-only');
  }

  function appendChatBubble(role, text) {
    const log = getChatLog();
    if (!log) return;

    if (role === 'status') {
      clearChatEmpty(log);
      const row = document.createElement('div');
      row.className = 'sai-msg-row sai-msg-row--typing jobbidhelper-chat-status';
      row.innerHTML = `
        <div class="sai-bot sai-bot--xs sai-mood-thinking">${renderSaiBot()}</div>
        <div class="sai-typing-bubble"><span></span><span></span><span></span></div>
      `;
      log.appendChild(row);
      log.scrollTop = log.scrollHeight;
      return row;
    }

    if (role === 'error') {
      clearChatEmpty(log);
      const row = document.createElement('div');
      row.className = 'sai-msg-row sai-msg-row--ai jobbidhelper-chat-error';
      row.innerHTML = `
        <div class="sai-bot sai-bot--xs sai-mood-error">${renderSaiBot()}</div>
        <div class="sai-msg-col">
          <div class="sai-msg-bubble sai-msg-bubble--ai sai-msg-bubble--error">${escapeHtml(text)}</div>
        </div>
      `;
      log.appendChild(row);
      log.scrollTop = log.scrollHeight;
      return row;
    }

    clearChatEmpty(log);
    const row = document.createElement('div');
    row.className = `sai-msg-row sai-msg-row--${role} jobbidhelper-chat-bubble jobbidhelper-chat-${role}`;

    if (role === 'user') {
      row.innerHTML = `
        <div class="sai-msg-col sai-msg-col--user">
          <div class="sai-msg-bubble sai-msg-bubble--user">${escapeHtml(text)}</div>
          <span class="sai-msg-time">${formatChatTime()} <span class="sai-read">✓✓</span></span>
        </div>
        <div class="sai-user-avatar" aria-hidden="true">U</div>
      `;
    } else {
      row.innerHTML = `
        <div class="sai-bot sai-bot--xs sai-mood-happy">${renderSaiBot()}</div>
        <div class="sai-msg-col">
          <div class="sai-msg-bubble sai-msg-bubble--ai">${escapeHtml(text)}</div>
          <span class="sai-msg-time">${formatChatTime()}</span>
        </div>
      `;
    }

    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    return row;
  }

  async function onChatSubmit(event) {
    event.preventDefault();
    event.stopPropagation();

    const input = document.getElementById('jobbidhelper-chat-input');
    const sendBtn = event.currentTarget.querySelector('button[type="submit"]');
    const text = (input?.value || '').trim();
    if (!text) return;

    input.value = '';
    appendChatBubble('user', text);
    const status = appendChatBubble('status', '');
    setSaiMood('thinking');
    if (sendBtn) sendBtn.disabled = true;

    try {
      const response = await sendMessageWithRetry({
        type: 'askPlatformAssistant',
        question: text
      });
      status?.remove();
      if (!response?.success || !response.answer) {
        throw new Error(response?.error || 'AI answer is not ready yet');
      }
      const answer = String(response.answer).trim();
      appendChatBubble('ai', answer);
      setSaiMood('happy', { holdMs: 4000 });
      try {
        await navigator.clipboard.writeText(answer);
      } catch (_) {}
    } catch (error) {
      status?.remove();
      appendChatBubble('error', error.message || 'Assistant failed');
      setSaiMood('error', { holdMs: 4000 });
      showToast(error.message || 'Assistant failed', 'error');
    } finally {
      if (sendBtn) sendBtn.disabled = false;
      input?.focus();
    }
  }

  async function getAIAnswerAndCopy(labelText, label) {
    showToast('Getting AI answer...', 'info');

    const inputType = 'text';
    const context = label ? getContextForInput(label) : '';

    try {
      const response = await sendMessageWithRetry({
        type: 'getAICompletion',
        data: { labelText, inputType, selectOptions: [], context }
      });

      if (response.success) {
        const answer = response.data;
        await navigator.clipboard.writeText(answer);
        showToast('Copied to clipboard: ' + answer.substring(0, 30) + '...', 'success');
      } else {
        showToast(response.error || 'AI request failed', 'error');
      }
    } catch (error) {
      showToast('Error: ' + error.message, 'error');
    }
  }

  function handleClick(event) {
    if (event.target.closest('#jobbidhelper-dock')) return;

    // Shift+Click to enter binding mode
    if (event.shiftKey) {
      const label = event.target.closest('label');
      if (label) {
        event.preventDefault();
        event.stopPropagation();
        enterBindingMode(label);
        return;
      }
    }

    // In binding mode, click to select target
    if (bindingMode) {
      event.preventDefault();
      event.stopPropagation();

      const input = event.target.closest('input, select, textarea');
      if (input && pendingLabel) {
        completeBinding(input);
      } else {
        exitBindingMode();
      }
    }
  }

  function enterBindingMode(label) {
    bindingMode = true;
    pendingLabel = label;
    label.classList.add('jobbidhelper-binding-mode');
    showToast('Now click the target input field', 'info');
  }

  function completeBinding(input) {
    const labelText = pendingLabel.textContent.trim();
    const inputSelector = getInputSelector(input);

    const bindingKey = `${window.location.origin}:${labelText}`;
    bindings[bindingKey] = inputSelector;

    // Visual feedback on target
    input.classList.add('jobbidhelper-filled');
    setTimeout(() => input.classList.remove('jobbidhelper-filled'), 500);

    // Save binding (fire and forget, don't block UI)
    sendMessageWithRetry({
      type: 'saveSettings',
      settings: { bindings: bindings }
    }).catch(() => {});

    pendingLabel.classList.remove('jobbidhelper-binding-mode');
    showToast(`Bound "${labelText.substring(0, 20)}..." to ${input.tagName.toLowerCase()}`, 'success');

    exitBindingMode();
  }

  function exitBindingMode() {
    if (pendingLabel) {
      pendingLabel.classList.remove('jobbidhelper-binding-mode');
    }
    bindingMode = false;
    pendingLabel = null;
  }

  function getInputSelector(input) {
    if (input.id) {
      return `#${CSS.escape(input.id)}`;
    }
    if (input.name && input.type !== 'text' && input.type !== 'email' && input.type !== 'password') {
      return `${input.tagName.toLowerCase()}[name="${CSS.escape(input.name)}"]`;
    }
    // Fallback to path
    return getElementPath(input);
  }

  function getElementPath(element) {
    const path = [];
    while (element && element.nodeType === Node.ELEMENT_NODE) {
      let selector = element.tagName.toLowerCase();
      if (element.id) {
        selector += `#${element.id}`;
        path.unshift(selector);
        break;
      } else if (element.className && typeof element.className === 'string') {
        const classes = element.className.trim().split(/\s+/).slice(0, 2);
        if (classes.length > 0 && classes[0]) {
          selector += '.' + classes.join('.');
        }
      }
      path.unshift(selector);
      element = element.parentElement;
    }
    return path.join(' > ');
  }

  function findLabelForSelection() {
    const selection = window.getSelection();
    if (!selection.rangeCount) return null;

    const range = selection.getRangeAt(0);
    let node = range.commonAncestorContainer;

    // Walk up to find a label element
    while (node && node !== document.body) {
      if (node.nodeName === 'LABEL') return node;
      if (node.nodeName === 'LEGEND') return node.parentElement;
      // Check for div-based labels (common in React/Vue frameworks)
      if (node.nodeType === Node.ELEMENT_NODE && isLabelElement(node)) return node;
      node = node.parentNode;
    }

    // Try finding label by proximity to selection
    const rect = range.getBoundingClientRect();
    const elements = document.elementsFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);

    for (const el of elements) {
      if (el.tagName === 'LABEL') return el;
      if (isLabelElement(el)) return el;
    }

    return null;
  }

  function isLabelElement(element) {
    // Check for common label class patterns used by React/Vue frameworks
    const className = element.className || '';
    const labelPatterns = ['field-label', 'label', 'form-label', 'input-label', 'form-field-label'];
    return labelPatterns.some(p => className.includes(p));
  }

  function findInputForLabel(label) {
    // Method 1: Check 'for' attribute
    const forAttr = label.getAttribute('for');
    if (forAttr) {
      const input = document.getElementById(forAttr);
      if (input && isFillable(input)) return input;
    }

    // Method 2: Check if label wraps an input
    const wrappedInput = label.querySelector('input, select, textarea');
    if (wrappedInput && isFillable(wrappedInput)) return wrappedInput;

    // Method 3: Check siblings - common in React/Vue (label and input are siblings)
    const parent = label.parentElement;
    if (parent) {
      const siblingInput = parent.querySelector('input, select, textarea');
      if (siblingInput && isFillable(siblingInput)) return siblingInput;
    }

    // Method 4: Proximity - find nearest fillable input
    return findNearestInput(label);
  }

  function findNearestInput(label) {
    const labelRect = label.getBoundingClientRect();
    const labelCenterX = labelRect.left + labelRect.width / 2;
    const labelBottom = labelRect.bottom;

    let nearestInput = null;
    let nearestDistance = Infinity;

    const fillables = document.querySelectorAll('input, select, textarea, [contenteditable]');

    fillables.forEach(input => {
      const rect = input.getBoundingClientRect();
      const inputTop = rect.top;

      // Only consider inputs below or at the label's bottom
      if (inputTop < labelBottom - 10) return;
      if (!isFillable(input)) return;

      // Calculate distance from label to input
      const distance = Math.abs(rect.left - labelCenterX) + Math.abs(rect.top - labelBottom);

      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestInput = input;
      }
    });

    return nearestInput;
  }

  function isFillable(element) {
    if (!element) return false;
    const tag = element.tagName.toLowerCase();
    const type = element.type?.toLowerCase() || 'text';

    const fillableTypes = [
      'text', 'email', 'password', 'search', 'tel', 'url', 'number',
      'textarea', 'select-one', 'select-multiple', 'checkbox', 'radio',
      'hidden', 'date', 'datetime-local', 'month', 'week', 'time'
    ];

    if (tag === 'textarea' || tag === 'select') return true;
    if (tag === 'input' && fillableTypes.includes(type)) return true;
    if (element.isContentEditable) return true;

    return false;
  }

  async function fillFieldWithAI(input, labelText, label) {
    showToast('Getting AI completion...', 'info');

    const inputType = getInputType(input);
    const selectOptions = getSelectOptions(input);
    const context = getContextForInput(input);

    try {
      const response = await sendMessageWithRetry({
        type: 'getAICompletion',
        data: { labelText, inputType, selectOptions, context }
      });

      if (response.success) {
        const answer = String(response.data || '').trim();
        try {
          await navigator.clipboard.writeText(answer);
        } catch (_) {}
        await fillInput(input, answer);
        showToast('Field filled!', 'success');
      } else {
        showToast(response.error || 'AI request failed', 'error');
      }
    } catch (error) {
      if (error.message.includes('Extension context invalidated')) {
        showToast('Extension reloading, please try again', 'error');
      } else {
        showToast('Error: ' + error.message, 'error');
      }
    }
  }

  function sendMessageWithRetry(message, retries = 2) {
    return new Promise((resolve, reject) => {
      const attempt = (count) => {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            if (count < retries) {
              // Service worker might be dormant, retry
              setTimeout(() => attempt(count + 1), 100);
            } else {
              reject(new Error(chrome.runtime.lastError.message || 'Extension context error'));
            }
          } else {
            resolve(response);
          }
        });
      };
      attempt(0);
    });
  }

  function getInputType(input) {
    if (input.tagName.toLowerCase() === 'select') {
      return input.multiple ? 'select-multiple' : 'select-one';
    }
    return input.type?.toLowerCase() || 'text';
  }

  function getSelectOptions(input) {
    if (input.tagName.toLowerCase() !== 'select') return [];

    const options = [];
    input.querySelectorAll('option').forEach(opt => {
      if (opt.value) {
        options.push(opt.textContent.trim());
      }
    });
    return options;
  }

  function getContextForInput(input) {
    // Get surrounding context to help AI
    const container = input.closest('form, div, section, fieldset');
    if (!container) return '';

    // Get other field labels nearby
    const nearbyLabels = [];
    container.querySelectorAll('label, legend, [data-label]').forEach(el => {
      const text = el.textContent.trim();
      if (text && text !== input.id && text.length < 100) {
        nearbyLabels.push(text);
      }
    });

    return nearbyLabels.slice(0, 10).join(' | ');
  }

  function setNativeValue(element, value) {
    const proto = element.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) {
      setter.call(element, value);
    } else {
      element.value = value;
    }
    const tracker = element._valueTracker;
    if (tracker) tracker.setValue('');
  }

  async function typeLastChars(element, text, contentEditable = false) {
    const full = String(text ?? '');
    const tailCount = Math.min(3, full.length);
    const prefix = full.slice(0, full.length - tailCount);
    const suffix = full.slice(full.length - tailCount);

    element.focus();

    if (contentEditable) {
      element.textContent = prefix;
    } else {
      setNativeValue(element, prefix);
    }
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: prefix ? 'insertFromPaste' : 'deleteContentBackward',
      data: prefix || null
    }));

    for (const ch of suffix) {
      await sleep(35 + Math.floor(Math.random() * 45));

      const keyOpts = {
        key: ch,
        code: /^[a-zA-Z]$/.test(ch) ? `Key${ch.toUpperCase()}` : ch,
        bubbles: true,
        cancelable: true
      };
      element.dispatchEvent(new KeyboardEvent('keydown', keyOpts));
      element.dispatchEvent(new KeyboardEvent('keypress', keyOpts));

      if (contentEditable) {
        element.textContent = (element.textContent || '') + ch;
      } else {
        setNativeValue(element, (element.value || '') + ch);
      }

      element.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: ch
      }));
      element.dispatchEvent(new KeyboardEvent('keyup', keyOpts));
    }

    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function fillInput(input, value) {
    const type = getInputType(input);
    const text = String(value ?? '');

    // Highlight the input briefly
    input.classList.add('jobbidhelper-filled');
    setTimeout(() => input.classList.remove('jobbidhelper-filled'), 1000);

    if (type === 'checkbox') {
      const yesMatch = /^(yes|y|true|enabled?|enable|1|on|checked?)$/i.test(text);
      input.checked = yesMatch;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (type === 'radio') {
      // Find matching radio option
      const radios = document.querySelectorAll(`input[name="${CSS.escape(input.name)}"]`);
      const normalizedValue = text.toLowerCase().trim();

      for (const radio of radios) {
        const label = findLabelForRadio(radio);
        if (label && label.toLowerCase().includes(normalizedValue)) {
          radio.checked = true;
          radio.dispatchEvent(new Event('change', { bubbles: true }));
          break;
        }
      }
    } else if (type === 'select-one' || type === 'select-multiple') {
      const normalizedValue = text.toLowerCase().trim();
      const options = input.querySelectorAll('option');

      let matched = false;
      for (const option of options) {
        const optionText = option.textContent.trim().toLowerCase();
        if (optionText === normalizedValue || optionText.includes(normalizedValue) || normalizedValue.includes(optionText)) {
          option.selected = true;
          matched = true;
        } else if (type === 'select-multiple') {
          // For multi-select, match individual words
          const words = normalizedValue.split(/\s+/);
          if (words.some(w => optionText.includes(w) || w.includes(optionText))) {
            option.selected = true;
            matched = true;
          }
        }
      }

      if (!matched && options.length > 0) {
        // Fallback to first non-empty option
        for (const option of options) {
          if (option.value) {
            option.selected = true;
            break;
          }
        }
      }

      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (input.isContentEditable) {
      // Paste all but last 3 chars, then type the rest
      await typeLastChars(input, text, true);
    } else {
      // Text, email, textarea, etc.
      await typeLastChars(input, text, false);
    }
  }

  function findLabelForRadio(radio) {
    // Check for associated label
    if (radio.id) {
      const label = document.querySelector(`label[for="${CSS.escape(radio.id)}"]`);
      if (label) return label.textContent.trim();
    }

    // Check if wrapped by label
    const parent = radio.parentElement;
    if (parent && parent.tagName === 'LABEL') {
      return parent.textContent.trim();
    }

    // Check for aria-label
    if (radio.getAttribute('aria-label')) {
      return radio.getAttribute('aria-label');
    }

    // Check for nearby text
    const container = radio.closest('label, span, div');
    if (container) {
      return container.textContent.trim();
    }

    return '';
  }

  function clearSelection() {
    window.getSelection()?.removeAllRanges();
  }

  // Toast notification system
  function showToast(message, type = 'info') {
    const moodMap = { success: 'success', error: 'error', info: 'thinking' };
    setSaiMood(moodMap[type] || 'idle', { holdMs: 2600 });

    const existing = document.getElementById('jobbidhelper-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'jobbidhelper-toast';
    toast.className = `jobbidhelper-toast jobbidhelper-toast-${type} sai-toast`;
    toast.innerHTML = `
      <div class="sai-toast-inner">
        <div class="sai-bot sai-bot--toast sai-mood-${moodMap[type] || 'idle'}">${renderSaiBot()}</div>
        <span class="sai-toast-text">${escapeHtml(message)}</span>
      </div>
    `;

    document.body.appendChild(toast);

    requestAnimationFrame(() => {
      toast.classList.add('jobbidhelper-toast-show');
    });

    setTimeout(() => {
      toast.classList.remove('jobbidhelper-toast-show');
      setTimeout(() => toast.remove(), 320);
    }, 2800);
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
})();
