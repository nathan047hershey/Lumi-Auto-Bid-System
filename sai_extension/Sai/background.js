// background.js - Service Worker for MiniMax AI API calls

const DEFAULT_SETTINGS = {
  apiKeys: { minimax: '' },
  systemPrompt: 'You are a helpful job application assistant. Provide concise, appropriate answers.',
  profileJson: ''
};

const MINIMAX_API_URL = 'https://api.minimax.io/v1/chat/completions';
const MINIMAX_MODEL = 'MiniMax-M2.7';

const APPLY_PATH = /\/jobs\/[0-9a-f-]{36}\/apply/i;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'getAICompletion') {
    handleAIRequest(message.data)
      .then(response => sendResponse({ success: true, data: response }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'getAIBatchCompletion') {
    handleAIBatchRequest(message.data)
      .then((answers) => sendResponse({ success: true, answers }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'getSettings') {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => sendResponse(settings));
    return true;
  }

  if (message.type === 'saveSettings') {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (existing) => {
      const incoming = message.settings || {};
      const merged = {
        ...existing,
        ...incoming,
        apiKeys: { ...(existing.apiKeys || {}), ...(incoming.apiKeys || {}) }
      };
      chrome.storage.sync.set(merged, () => sendResponse({ success: true }));
    });
    return true;
  }

  if (message.type === 'tryJdHandoff') {
    tryJdHandoff(sender.tab, message.text)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ handoff: false, error: error.message }));
    return true;
  }

  if (message.type === 'hasPairedPlatform') {
    hasPairedPlatform(sender.tab)
      .then(result => sendResponse(result))
      .catch(() => sendResponse({ paired: false }));
    return true;
  }

  if (message.type === 'clickPlatformAction') {
    clickPlatformAction(sender.tab, message.action)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'askPlatformAssistant') {
    askPlatformAssistant(sender.tab, message.question)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'greenhouseGetProfile') {
    getGreenhouseProfile()
      .then((profile) => sendResponse({ success: true, profile }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'greenhouseStartAutofill') {
    startGreenhouseAutofill(sender.tab)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'ensureGreenhouseScript') {
    ensureGreenhouseScript(sender.tab)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

});

function isPlatformApplyUrl(url) {
  try {
    return APPLY_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

async function hasPairedPlatform(jobTab) {
  if (!jobTab || isPlatformApplyUrl(jobTab.url)) return { paired: false };
  const leftTab = await findLeftPlatformTab(jobTab);
  return { paired: !!leftTab };
}

async function findLeftPlatformTab(jobTab) {
  if (!jobTab) return null;
  const windowTabs = await chrome.tabs.query({ windowId: jobTab.windowId });
  const ordered = [...windowTabs].sort((a, b) => a.index - b.index);

  // Prefer tab immediately to the left
  const leftTab = ordered.find((tab) => tab.index === jobTab.index - 1);
  if (leftTab && isPlatformApplyUrl(leftTab.url)) return leftTab;

  // Fallback: nearest apply tab to the left
  for (let i = ordered.length - 1; i >= 0; i--) {
    const tab = ordered[i];
    if (tab.index >= jobTab.index) continue;
    if (isPlatformApplyUrl(tab.url)) return tab;
  }
  return null;
}

async function requireLeftPlatformTab(jobTab) {
  if (!jobTab) {
    throw new Error('No job tab');
  }
  if (isPlatformApplyUrl(jobTab.url)) {
    throw new Error('Run this on the job posting tab, not the platform tab');
  }
  const leftTab = await findLeftPlatformTab(jobTab);
  if (!leftTab) {
    throw new Error('No platform apply tab immediately to the left');
  }
  await waitForTabComplete(leftTab.id);
  return leftTab;
}

async function clickPlatformAction(jobTab, action) {
  const leftTab = await requireLeftPlatformTab(jobTab);

  // Skip current pair → open next job + platform (do not mark applied)
  if (action === 'clickSkipToNext') {
    try {
      await openNextJobPair(jobTab, leftTab);
      return { success: true, nextJobOpened: true, skipped: true };
    } catch (error) {
      throw new Error(error.message || 'Could not open the next job');
    }
  }

  await ensureContentScript(leftTab.id);
  const response = await sendToTabWithRetry(leftTab.id, { type: action });
  if (!response?.success) {
    throw new Error(response?.error || 'Platform action failed');
  }

  if (action === 'clickMarkApplied') {
    try {
      await openNextJobPair(jobTab, leftTab);
      return { success: true, nextJobOpened: true };
    } catch (error) {
      return { success: true, nextJobWarning: error.message };
    }
  }

  return { success: true };
}

function isInjectableTabUrl(url) {
  if (!url) return false;
  return /^(https?:|file:)/i.test(url);
}

async function ensureContentScript(tabId) {
  try {
    await sendToTabWithRetry(tabId, { type: 'ping' }, 2);
    return;
  } catch (_) {}

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js']
  });
  await sendToTabWithRetry(tabId, { type: 'ping' }, 20);
}

async function findJobListTab(windowId) {
  const windowTabs = await chrome.tabs.query({ windowId });
  const ordered = [...windowTabs].sort((a, b) => a.index - b.index);
  const candidates = ordered.filter((tab) => isInjectableTabUrl(tab.url));

  // Prefer pinned first tab, then any tab that reports a job list table.
  const preferred = candidates.filter((tab) => tab.index === 0 || tab.pinned);
  const rest = candidates.filter((tab) => !(tab.index === 0 || tab.pinned));

  for (const tab of [...preferred, ...rest]) {
    try {
      await waitForTabComplete(tab.id);
      await ensureContentScript(tab.id);
      const probe = await sendToTabWithRetry(tab.id, { type: 'probeJobList' }, 3);
      if (probe?.success && probe.isJobList) return tab;
    } catch (_) {}
  }

  return null;
}

async function openNextJobPair(jobTab, platformTab) {
  const listTab = await findJobListTab(jobTab.windowId);
  if (!listTab) {
    throw new Error('Job list tab not found — pin it first and reload that tab');
  }

  await ensureContentScript(listTab.id);

  const clicked = await sendToTabWithRetry(listTab.id, { type: 'clickNextJobLinks' });
  if (!clicked?.success || !clicked.platformUrl || !clicked.jobUrl) {
    throw new Error(clicked?.error || 'Could not click the next job links');
  }

  const insertIndex = platformTab.index;

  // Open both tabs immediately (extension API) — page clicks only update list styles.
  await chrome.tabs.create({
    url: clicked.platformUrl,
    index: insertIndex,
    active: false,
    windowId: jobTab.windowId
  });

  const newJobTab = await chrome.tabs.create({
    url: clicked.jobUrl,
    index: insertIndex + 1,
    active: false,
    windowId: jobTab.windowId
  });

  try {
    await chrome.tabs.update(newJobTab.id, { active: true });
  } catch (_) {}

  // Wait for new tabs to finish loading before closing old ones
  const waitForTabs = async (ids, timeoutMs = 8000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const tabs = await Promise.all(ids.map(id => chrome.tabs.get(id)));
        if (tabs.every(tab => tab && tab.status === 'complete')) return true;
      } catch (_) {}
      await sleepMs(300);
    }
    return false;
  };

  const tabsReady = await waitForTabs([newJobTab.id]);
  if (tabsReady) {
    try {
      await chrome.tabs.remove([platformTab.id, jobTab.id]);
    } catch (_) {}
  } else {
    // Tabs taking too long — remove anyway but log warning
    console.warn('[Sai] New tabs did not load in time, removing old tabs anyway');
    try {
      await chrome.tabs.remove([platformTab.id, jobTab.id]);
    } catch (_) {}
  }
}

async function askPlatformAssistant(jobTab, question) {
  const q = (question || '').trim();
  if (!q) {
    throw new Error('Select a question first');
  }

  const leftTab = await requireLeftPlatformTab(jobTab);
  await ensureContentScript(leftTab.id);

  const submitted = await sendToTabWithRetry(leftTab.id, {
    type: 'askAssistant',
    question: q
  });
  if (!submitted?.success || !submitted.submitted) {
    throw new Error(submitted?.error || 'Could not send question to platform assistant');
  }

  // First wait 6s, then check up to 10 times every 2s for Copy answer.
  await sleepMs(6000);

  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt > 0) await sleepMs(2000);

    const polled = await sendToTabWithRetry(leftTab.id, {
      type: 'pollAssistantAnswer',
      countBefore: submitted.countBefore,
      question: q
    }, 3);

    const answer = String(polled?.answer || '').trim();
    if (polled?.success && answer) {
      return { success: true, answer };
    }
  }

  throw new Error('AI answer is not ready yet');
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryJdHandoff(jobTab, text) {
  const jd = (text || '').trim();
  if (!jd) {
    throw new Error('Select the job description first');
  }

  const leftTab = await requireLeftPlatformTab(jobTab);
  await ensureContentScript(leftTab.id);

  const response = await sendToTabWithRetry(leftTab.id, {
    type: 'fillJdAndGenerate',
    text: jd
  });

  if (!response?.success) {
    throw new Error(response?.error || 'Could not paste JD on the platform tab');
  }

  return { handoff: true };
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        resolve();
        return;
      }
      if (tab.status === 'complete') {
        resolve();
        return;
      }
      const onUpdated = (id, info) => {
        if (id === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }, 8000);
    });
  });
}

function sendToTabWithRetry(tabId, message, retries = 5) {
  return new Promise((resolve, reject) => {
    const attempt = (count) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          if (count < retries) {
            setTimeout(() => attempt(count + 1), 250);
          } else {
            reject(new Error(chrome.runtime.lastError.message || 'Tab is not ready'));
          }
        } else {
          resolve(response);
        }
      });
    };
    attempt(0);
  });
}

async function getGreenhouseProfile() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  let raw = null;

  if (settings.profileJson?.trim()) {
    try {
      raw = JSON.parse(settings.profileJson);
    } catch (_) {}
  }

  if (!raw || typeof raw !== 'object') {
    raw = parseProfileFromSystemPrompt(settings.systemPrompt || '');
  }

  if (!raw || typeof raw !== 'object') {
    throw new Error('No profile found. Open Sai → Profile tab and paste your profile JSON.');
  }
  return normalizeGreenhouseProfile(raw);
}

function buildAiSystemPrompt(settings) {
  const base = settings.systemPrompt || DEFAULT_SETTINGS.systemPrompt;
  const profile = (settings.profileJson || '').trim();
  if (profile) {
    return `${base}\n\nCandidate profile (use for accurate answers):\n${profile}`;
  }
  return base;
}

async function ensureGreenhouseScript(tab) {
  if (!tab?.id) throw new Error('No tab');
  try {
    const ping = await sendToTabWithRetry(
      tab.id,
      { type: 'greenhousePing', platform: 'greenhouse' },
      2
    );
    if (ping?.success) {
      await sendToTabWithRetry(tab.id, { type: 'greenhouseShowOffer', platform: 'greenhouse' }, 2);
      return { alreadyLoaded: true };
    }
  } catch (_) {}

  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    files: ['autofill/greenhouse_auto.js']
  });
  await sleepMs(200);
  try {
    await sendToTabWithRetry(tab.id, { type: 'greenhouseShowOffer', platform: 'greenhouse' }, 4);
  } catch (_) {}
  return { injected: true };
}

async function startGreenhouseAutofill(tab) {
  if (!tab?.id) throw new Error('No Greenhouse tab');
  const profile = await getGreenhouseProfile();

  try {
    await sendToTabWithRetry(tab.id, { type: 'greenhousePing', platform: 'greenhouse' }, 2);
  } catch (_) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['autofill/greenhouse_auto.js']
    });
  }

  const res = await sendToTabWithRetry(
    tab.id,
    { type: 'fillGreenhouseProfile', platform: 'greenhouse', profile },
    6
  );
  if (!res?.success) {
    throw new Error(res?.error || 'Greenhouse fill failed');
  }
  return res;
}

function parseProfileFromSystemPrompt(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

function normalizeGreenhouseProfile(raw) {
  const personal = raw.personal || raw.contact || {};
  const address = raw.address || raw.location || {};
  const eeoc =
    raw.eeoc ||
    raw.eeo ||
    raw.eeoSelfIdentification ||
    raw.voluntarySelfIdentification ||
    {};
  const workAuthBlock = raw.workAuthorization || {};
  const screening = raw.screeningQuestions || raw.screening || {};

  const city =
    address.city ||
    (address.cityOnly && address.state
      ? `${address.cityOnly}, ${address.state}`
      : address.cityOnly) ||
    raw.city ||
    '';

  const raceFromEeo = Array.isArray(eeoc.ethnicityRace)
    ? eeoc.ethnicityRace[0] || eeoc.ethnicityRace.join(', ')
    : eeoc.race || eeoc.ethnicity || '';

  const hispanicRaw = eeoc.hispanicLatino ?? eeoc.hispanicOrLatino ?? eeoc.hispanic;
  const hispanicLatino =
    hispanicRaw === true || hispanicRaw === 'Yes' || hispanicRaw === 'yes'
      ? 'Yes'
      : hispanicRaw === false || hispanicRaw === 'No' || hispanicRaw === 'no'
        ? 'No'
        : hispanicRaw || 'No';

  const education = Array.isArray(raw.education)
    ? raw.education.map((e) => ({
        school: e.school || e.university || e.name || '',
        schoolSearch: e.schoolSearch || e.schoolShort || e.universitySearch || e.search || '',
        degree: e.degree || '',
        field: e.field || e.discipline || e.major || '',
        fieldSearch: e.fieldSearch || e.majorSearch || e.disciplineSearch || e.fieldShort || '',
        startYear: e.startYear || e.start || '',
        endYear: e.endYear || e.end || e.graduationYear || '',
        startMonth: e.startMonth || '',
        endMonth: e.endMonth || ''
      }))
    : [];

  const MONTH_NAMES = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December'
  ];

  function monthNameFromValue(v) {
    if (v == null || v === '') return '';
    const s = String(v).trim();
    if (/^\d{1,2}$/.test(s)) {
      const n = parseInt(s, 10);
      return n >= 1 && n <= 12 ? MONTH_NAMES[n - 1] : '';
    }
    const lower = s.toLowerCase();
    const hit = MONTH_NAMES.find(
      (m) => m.toLowerCase() === lower || m.toLowerCase().startsWith(lower.slice(0, 3))
    );
    return hit || s;
  }

  /** Parse "09/2022", "9/2022", "2022-09", "September 2022", "Present", etc. */
  function parseWorkDate(rawDate) {
    const s = String(rawDate || '').trim();
    if (!s) return { month: '', year: '', current: false };
    if (/^(present|current|now|ongoing)$/i.test(s)) {
      return { month: '', year: '', current: true };
    }
    let m = s.match(/^(\d{1,2})\s*[\/\-]\s*(\d{4})$/);
    if (m) return { month: monthNameFromValue(m[1]), year: m[2], current: false };
    m = s.match(/^(\d{4})\s*[\/\-]\s*(\d{1,2})$/);
    if (m) return { month: monthNameFromValue(m[2]), year: m[1], current: false };
    m = s.match(/^([A-Za-z]+)\s+(\d{4})$/);
    if (m) return { month: monthNameFromValue(m[1]), year: m[2], current: false };
    m = s.match(/^(\d{4})$/);
    if (m) return { month: '', year: m[1], current: false };
    return { month: '', year: '', current: false };
  }

  const employmentRaw =
    raw.employment || raw.workExperience || raw.experience || raw.workHistory || [];
  const employment = Array.isArray(employmentRaw)
    ? employmentRaw.map((e) => {
        const start = parseWorkDate(e.startDate || e.start || '');
        const end = parseWorkDate(e.endDate || e.end || '');
        const current =
          end.current ||
          e.current === true ||
          e.currentRole === true ||
          e.isCurrent === true ||
          /^(yes|true|1|current|present)$/i.test(String(e.current || e.currentRole || e.endDate || ''));
        return {
          company: e.company || e.companyName || e.employer || e.organization || '',
          title: e.title || e.jobTitle || e.role || e.position || '',
          startMonth: monthNameFromValue(e.startMonth || e.startDateMonth) || start.month,
          startYear:
            String(e.startYear || e.startDateYear || '').replace(/\D/g, '').slice(0, 4) || start.year,
          endMonth: current
            ? ''
            : monthNameFromValue(e.endMonth || e.endDateMonth) || end.month,
          endYear: current
            ? ''
            : String(e.endYear || e.endDateYear || '').replace(/\D/g, '').slice(0, 4) || end.year,
          current
        };
      })
    : [];

  /** Keep only real text — never pass booleans / "true" / "false" into form fields. */
  function asText(value, fallback = '') {
    if (value == null || value === '') return fallback;
    if (typeof value === 'boolean') return fallback;
    const s = String(value).trim();
    if (!s || /^true$/i.test(s) || /^false$/i.test(s)) return fallback;
    return s;
  }

  function asYesNo(value, fallback = '') {
    if (value === true || value === 'Yes' || value === 'yes') return 'Yes';
    if (value === false || value === 'No' || value === 'no') return 'No';
    const s = asText(value);
    return s || fallback;
  }

  // Drop boolean-only screening entries so they cannot leak into text inputs
  const screeningClean = {};
  if (screening && typeof screening === 'object' && !Array.isArray(screening)) {
    for (const [key, value] of Object.entries(screening)) {
      if (typeof value === 'boolean') {
        screeningClean[key] = value; // keep for checkbox matching only
        continue;
      }
      const text = asText(value);
      if (text) screeningClean[key] = text;
    }
  }

  return {
    firstName: asText(personal.firstName || personal.first_name || raw.firstName),
    lastName: asText(personal.lastName || personal.last_name || raw.lastName),
    preferredName: asText(personal.preferredName || personal.preferred_name),
    email: asText(personal.email || raw.email),
    phone: asText(personal.phone || personal.phoneNumber || raw.phone),
    linkedin: asText(personal.linkedin || personal.linkedinUrl || raw.linkedin),
    website: asText(personal.website || personal.portfolio || raw.website),
    age: asText(personal.age || raw.age),
    birthday: asText(personal.birthday || personal.birthDate),
    country: asText(address.country || raw.country, 'United States'),
    state: asText(address.state || address.region),
    city: asText(city),
    zipCode: asText(address.zipCode || address.zip || address.postalCode),
    gender: asText(personal.gender || eeoc.gender, 'Male'),
    hispanicLatino: asYesNo(hispanicLatino, 'No'),
    race: asText(raceFromEeo, 'Two or More Races'),
    veteranStatus: asText(
      eeoc.veteranStatus || eeoc.veteran,
      'I am not a protected veteran'
    ),
    disabilityStatus: asYesNo(eeoc.disabilityStatus || eeoc.disability, 'No'),
    workAuth: asYesNo(
      screening.workAuthorization ||
        screening.authorizedToWork ||
        (workAuthBlock.legallyAuthorizedToWorkInUS === true
          ? 'Yes'
          : workAuthBlock.legallyAuthorizedToWorkInUS === false
            ? 'No'
            : '') ||
        raw.workAuth,
      'Yes'
    ),
    sponsorship: asYesNo(
      screening.sponsorship ||
        screening.needsSponsorship ||
        (workAuthBlock.requiresSponsorship === true
          ? 'Yes'
          : workAuthBlock.requiresSponsorship === false
            ? 'No'
            : '') ||
        raw.sponsorship,
      'No'
    ),
    education,
    employment,
    screeningQuestions: screeningClean,
    profileSummary: asText(
      raw.profileSummary ||
        raw.summary ||
        (typeof raw.professionalProfile === 'string' ? raw.professionalProfile : '') ||
        (typeof raw.about === 'string' ? raw.about : '')
    )
  };
}

async function handleAIRequest(data) {
  const { labelText, inputType, selectOptions, context } = data;
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const apiKey = settings.apiKeys?.minimax || settings.apiKeys?.groq;

  if (!apiKey) {
    throw new Error('MiniMax API key not set. Please configure in extension popup.');
  }

  const userPrompt = buildUserPrompt(labelText, inputType, selectOptions, context);
  return callMiniMaxAPI(userPrompt, buildAiSystemPrompt(settings), apiKey, 400);
}

/** One request for many Greenhouse fields (saves API rate limits). */
async function handleAIBatchRequest(data) {
  const questions = Array.isArray(data?.questions) ? data.questions : [];
  if (!questions.length) return {};

  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const apiKey = settings.apiKeys?.minimax || settings.apiKeys?.groq;
  if (!apiKey) {
    throw new Error('MiniMax API key not set. Please configure in extension popup.');
  }

  const userPrompt = buildBatchPrompt(questions, data.context || '');
  const raw = await callMiniMaxAPI(
    userPrompt,
    buildAiSystemPrompt(settings),
    apiKey,
    Math.min(4000, 200 + questions.length * 180)
  );
  return parseBatchAnswers(raw, questions);
}

function buildUserPrompt(labelText, inputType, selectOptions, context) {
  let prompt = `Label: "${labelText}"`;

  if (inputType === 'select-one' && selectOptions?.length > 0) {
    prompt += `\nOptions: ${selectOptions.join(', ')}`;
    prompt += `\nReply with the best matching option text.`;
  } else if (inputType === 'checkbox') {
    prompt += `\nReply with just "yes" or "no".`;
  } else if (inputType === 'radio' && selectOptions?.length > 0) {
    prompt += `\nOptions: ${selectOptions.join(', ')}`;
    prompt += `\nReply with the best matching option.`;
  } else {
    prompt += `\nProvide a concise answer.`;
  }

  if (context) {
    prompt += `\nContext: ${context}`;
  }

  return prompt;
}

function buildBatchPrompt(questions, context) {
  const lines = [
    'Answer ALL job-application questions below in a single response.',
    'Return ONLY a valid JSON object mapping each question id to its answer string.',
    'No markdown fences, no commentary.',
    'For checkboxes: answer "yes" or "no".',
    'For select-one: answer with the exact option text when possible.',
    'For text/textarea: concise professional answers.',
    ''
  ];
  if (context) {
    lines.push('Shared context:', context, '');
  }
  lines.push('Questions:');
  questions.forEach((q, i) => {
    lines.push('');
    lines.push(`[${i + 1}] id="${q.id}"`);
    lines.push(`Type: ${q.inputType || 'text'}`);
    lines.push(`Label: ${q.labelText || 'Question'}`);
    if (q.hint) lines.push(`Hint: ${q.hint}`);
    if (q.selectOptions?.length) {
      lines.push(`Options: ${q.selectOptions.join(' | ')}`);
    }
  });
  lines.push('');
  lines.push('JSON shape example: {"q1":"answer","q2":"yes"}');
  return lines.join('\n');
}

function parseBatchAnswers(raw, questions) {
  const text = String(raw || '').trim();
  const answers = {};
  const ids = questions.map((q) => q.id);

  const tryParse = (s) => {
    try {
      const obj = JSON.parse(s);
      return obj && typeof obj === 'object' ? obj : null;
    } catch (_) {
      return null;
    }
  };

  let obj = tryParse(text);
  if (!obj) {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) obj = tryParse(fence[1].trim());
  }
  if (!obj) {
    const brace = text.match(/\{[\s\S]*\}/);
    if (brace) obj = tryParse(brace[0]);
  }

  if (obj) {
    for (const id of ids) {
      if (obj[id] != null) answers[id] = String(obj[id]).trim();
    }
    // Also accept numeric keys "1","2" matching order
    ids.forEach((id, i) => {
      if (!answers[id] && obj[String(i + 1)] != null) {
        answers[id] = String(obj[String(i + 1)]).trim();
      }
    });
    return answers;
  }

  // Fallback: if only one question, use whole reply
  if (questions.length === 1) {
    answers[questions[0].id] = text;
  }
  return answers;
}

function extractMiniMaxContent(message) {
  if (!message) return '';
  let content = String(message.content || '').trim();
  if (message.reasoning_content) {
    // reasoning_split=true — content is already the answer
    return content;
  }
  // Strip … blocks when reasoning is embedded in content
  content = content.replace(/[\s\S]*?<\/think>/gi, '').trim();
  return content;
}

async function callMiniMaxAPI(userPrompt, systemPrompt, apiKey, maxTokens = 400) {
  const response = await fetch(MINIMAX_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: MINIMAX_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.3,
      max_completion_tokens: maxTokens,
      reasoning_split: true
    })
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: response.statusText } }));
    const msg =
      error.error?.message ||
      error.base_resp?.status_msg ||
      error.message ||
      `MiniMax error: ${response.status}`;
    throw new Error(msg);
  }

  const data = await response.json();
  return extractMiniMaxContent(data.choices?.[0]?.message) || '';
}
