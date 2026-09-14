// popup.js — Settings page + form-based profile editor

const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful job application assistant. Provide concise, appropriate answers.';

// ── State ─────────────────────────────────────────────────────────────────────
let currentProfile = null;
let jsonMode = false;
let formDirty = false;

// ── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  setupEventListeners();
  setupTabs();
  setupProfileEditor();
});

// ── Tabs ─────────────────────────────────────────────────────────────────────
function setupTabs() {
  const tabs = document.querySelectorAll('.popup-tab');
  const panels = document.querySelectorAll('.popup-panel');

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const name = tab.getAttribute('data-tab');
      tabs.forEach((t) => {
        const active = t === tab;
        t.classList.toggle('active', active);
        t.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      panels.forEach((panel) => {
        const show = panel.id === `tab-${name}`;
        panel.classList.toggle('active', show);
        panel.hidden = !show;
      });
    });
  });
}

// ── Settings ───────────────────────────────────────────────────────────────────
function loadSettings() {
  chrome.runtime.sendMessage({ type: 'getSettings' }, (settings) => {
    if (!settings) return;

    document.getElementById('minimaxKey').value =
      settings.apiKeys?.minimax || settings.apiKeys?.groq || '';

    let profileJson = (settings.profileJson || '').trim();
    let systemPrompt = settings.systemPrompt || DEFAULT_SYSTEM_PROMPT;

    if (!profileJson) {
      const legacy = extractJsonFromText(systemPrompt);
      if (legacy) {
        profileJson = JSON.stringify(legacy, null, 2);
        systemPrompt = stripJsonFromSystemPrompt(systemPrompt);
      }
    }

    document.getElementById('systemPrompt').value = systemPrompt;

    if (profileJson) {
      try {
        currentProfile = JSON.parse(profileJson);
      } catch (_) {
        currentProfile = {};
      }
    } else {
      currentProfile = {};
    }

    // Populate form from profile
    populateFormFromProfile(currentProfile);
    updateProfileStatus(currentProfile);
  });
}

function setupEventListeners() {
  document.getElementById('saveBtn').addEventListener('click', saveSettings);

  // Mark form dirty on any input change
  document.getElementById('profileForm').addEventListener('input', (e) => {
    if (e.target.matches('input, textarea, select')) {
      formDirty = true;
      updateProfileStatus(currentProfile, true);
    }
  });
}

function saveSettings() {
  const statusEl = document.getElementById('saveStatus');
  const btn = document.getElementById('saveBtn');

  btn.disabled = true;
  statusEl.textContent = 'Saving...';
  statusEl.className = 'save-status';

  // Gather profile from form
  const profile = buildProfileFromForm();

  // Validate
  const errors = validateProfile(profile);
  if (errors.length > 0) {
    statusEl.textContent = errors[0];
    statusEl.className = 'save-status error';
    btn.disabled = false;
    return;
  }

  const profileJson = JSON.stringify(profile, null, 2);

  const settings = {
    apiKeys: { minimax: document.getElementById('minimaxKey').value.trim() },
    systemPrompt: document.getElementById('systemPrompt').value.trim() || DEFAULT_SYSTEM_PROMPT,
    profileJson
  };

  chrome.runtime.sendMessage({ type: 'saveSettings', settings }, (response) => {
    btn.disabled = false;

    if (response && response.success) {
      statusEl.textContent = 'Saved!';
      statusEl.className = 'save-status success';
      formDirty = false;
      updateProfileStatus(profile);
      setTimeout(() => { statusEl.textContent = ''; }, 2000);
    } else {
      statusEl.textContent = 'Error';
      statusEl.className = 'save-status error';
    }
  });
}

// ── JSON Helpers ───────────────────────────────────────────────────────────────
function extractJsonFromText(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(s.slice(start, end + 1));
    return obj && typeof obj === 'object' ? obj : null;
  } catch (_) {
    return null;
  }
}

function stripJsonFromSystemPrompt(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start === -1) return s.trim();
  const before = s.slice(0, start).trim();
  return before || DEFAULT_SYSTEM_PROMPT;
}

// ── Profile Editor ────────────────────────────────────────────────────────────
function setupProfileEditor() {
  // Section collapse/expand
  document.querySelectorAll('.profile-section-header').forEach((header) => {
    header.addEventListener('click', (e) => {
      if (e.target.closest('.section-add-btn')) return;
      const expanded = header.getAttribute('aria-expanded') === 'true';
      header.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    });
  });

  // Add buttons for employment and education
  document.querySelector('[data-add="employment"]')?.addEventListener('click', () => {
    addEmploymentEntry();
  });
  document.querySelector('[data-add="education"]')?.addEventListener('click', () => {
    addEducationEntry();
  });

  // Import / Export / JSON toggle
  document.getElementById('importBtn').addEventListener('click', importProfile);
  document.getElementById('exportBtn').addEventListener('click', exportProfile);
  document.getElementById('toggleJsonBtn').addEventListener('click', toggleJsonMode);

  // File import
  document.getElementById('importFile').addEventListener('change', handleFileImport);

  // JSON editor sync
  const jsonTa = document.getElementById('profileJson');
  jsonTa.addEventListener('input', () => {
    try {
      const parsed = JSON.parse(jsonTa.value);
      currentProfile = parsed;
      updateProfileStatus(parsed);
    } catch (_) {
      updateProfileStatus(null);
    }
  });

  // Render initial entries
  renderEmploymentEntries();
  renderEducationEntries();
}

// ── Form ↔ Profile ────────────────────────────────────────────────────────────
function populateFormFromProfile(profile) {
  if (!profile) return;
  const p = profile.personal || profile;
  const addr = profile.address || {};

  setVal('firstName', p.firstName || p.first_name || '');
  setVal('lastName', p.lastName || p.last_name || '');
  setVal('preferredName', p.preferredName || p.preferred_name || '');
  setVal('email', p.email || '');
  setVal('phone', p.phone || p.phoneNumber || '');
  setVal('linkedin', p.linkedin || p.linkedinUrl || '');
  setVal('website', p.website || p.portfolio || '');
  setVal('age', p.age || '');

  setVal('country', addr.country || profile.country || 'United States');
  setVal('state', addr.state || addr.region || '');
  setVal('city', addr.city || profile.city || '');
  setVal('zipCode', addr.zipCode || addr.zip || addr.postalCode || '');

  setVal('gender', p.gender || '');
  setVal('hispanicLatino', profile.hispanicLatino || '');
  setVal('race', profile.race || '');
  setVal('veteranStatus', profile.veteranStatus || '');
  setVal('disabilityStatus', profile.disabilityStatus || '');
  setVal('workAuth', profile.workAuth || '');
  setVal('sponsorship', profile.sponsorship || '');
  setVal('profileSummary', profile.profileSummary || profile.summary || '');

  renderEmploymentEntries(profile.employment || profile.workExperience || []);
  renderEducationEntries(profile.education || []);
}

function buildProfileFromForm() {
  const profile = {
    personal: {
      firstName: getVal('firstName'),
      lastName: getVal('lastName'),
      preferredName: getVal('preferredName'),
      email: getVal('email'),
      phone: getVal('phone'),
      linkedin: getVal('linkedin'),
      website: getVal('website'),
      age: getVal('age') ? String(getVal('age')) : ''
    },
    address: {
      country: getVal('country') || 'United States',
      state: getVal('state'),
      city: getVal('city'),
      zipCode: getVal('zipCode')
    },
    gender: getVal('gender'),
    hispanicLatino: getVal('hispanicLatino'),
    race: getVal('race'),
    veteranStatus: getVal('veteranStatus'),
    disabilityStatus: getVal('disabilityStatus'),
    workAuth: getVal('workAuth'),
    sponsorship: getVal('sponsorship'),
    profileSummary: getVal('profileSummary'),
    employment: buildEmploymentEntries(),
    education: buildEducationEntries()
  };

  // Clean empty strings
  if (!profile.personal.firstName) delete profile.personal.firstName;
  if (!profile.personal.lastName) delete profile.personal.lastName;
  if (!profile.personal.preferredName) delete profile.personal.preferredName;
  if (!profile.personal.email) delete profile.personal.email;
  if (!profile.personal.phone) delete profile.personal.phone;
  if (!profile.personal.linkedin) delete profile.personal.linkedin;
  if (!profile.personal.website) delete profile.personal.website;
  if (!profile.personal.age) delete profile.personal.age;

  if (!profile.address.country) delete profile.address.country;
  if (!profile.address.state) delete profile.address.state;
  if (!profile.address.city) delete profile.address.city;
  if (!profile.address.zipCode) delete profile.address.zipCode;

  if (!profile.profileSummary) delete profile.profileSummary;

  // Only save EEOC fields when user actually selected something
  if (!profile.gender) delete profile.gender;
  if (!profile.hispanicLatino) delete profile.hispanicLatino;
  if (!profile.race) delete profile.race;
  if (!profile.veteranStatus) delete profile.veteranStatus;
  if (!profile.disabilityStatus) delete profile.disabilityStatus;
  if (!profile.workAuth) delete profile.workAuth;
  if (!profile.sponsorship) delete profile.sponsorship;

  return profile;
}

function getVal(id) {
  const el = document.getElementById(id);
  return el ? (el.value || '').trim() : '';
}

function setVal(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value || '';
}

// ── Work Experience Entries ────────────────────────────────────────────────────
function renderEmploymentEntries(entries = []) {
  const list = document.getElementById('employmentList');
  list.innerHTML = '';

  if (entries.length === 0) {
    list.innerHTML = `
      <div class="entry-empty">
        <span>No work experience added yet</span>
        <button type="button" class="btn-secondary" style="font-size:11px;padding:3px 10px" onclick="addEmploymentEntry()">+ Add job</button>
      </div>`;
    return;
  }

  entries.forEach((entry, i) => {
    const card = document.createElement('div');
    card.className = 'entry-card';
    card.dataset.index = i;
    card.innerHTML = `
      <div class="entry-card-header">
        <span class="entry-card-title">${escapeHtml(entry.company || `Job ${i + 1}`)}</span>
        <button type="button" class="entry-card-remove" title="Remove" onclick="removeEmploymentEntry(${i})">×</button>
      </div>
      <div class="entry-card-body">
        <div class="field-row">
          <div class="field-group">
            <label>Company</label>
            <input type="text" data-emp="company" value="${escapeHtml(entry.company || '')}" placeholder="Acme Corp">
          </div>
          <div class="field-group">
            <label>Title</label>
            <input type="text" data-emp="title" value="${escapeHtml(entry.title || '')}" placeholder="Software Engineer">
          </div>
        </div>
        <div class="field-row">
          <div class="field-group">
            <label>Start Date</label>
            <input type="text" data-emp="startDate" value="${escapeHtml(entry.startDate || '')}" placeholder="09/2022">
          </div>
          <div class="field-group">
            <label>End Date</label>
            <input type="text" data-emp="endDate" value="${escapeHtml(entry.endDate || '')}" placeholder="Present">
          </div>
        </div>
        <div class="form-group">
          <label>Description</label>
          <textarea data-emp="description" rows="2" placeholder="Key responsibilities and achievements...">${escapeHtml(entry.description || '')}</textarea>
        </div>
      </div>`;
    list.appendChild(card);
  });
}

function addEmploymentEntry() {
  const profile = buildProfileFromForm();
  profile.employment = profile.employment || [];
  profile.employment.push({ company: '', title: '', startDate: '', endDate: '', description: '' });
  currentProfile = profile;
  renderEmploymentEntries(profile.employment);
  formDirty = true;
}

function removeEmploymentEntry(index) {
  const cards = document.querySelectorAll('#employmentList .entry-card');
  const card = cards[index];
  if (card) {
    card.style.transition = 'opacity 0.2s, transform 0.2s';
    card.style.opacity = '0';
    card.style.transform = 'scale(0.95)';
    setTimeout(() => {
      const profile = buildProfileFromForm();
      profile.employment = profile.employment || [];
      profile.employment.splice(index, 1);
      currentProfile = profile;
      renderEmploymentEntries(profile.employment);
      formDirty = true;
    }, 200);
  }
}

function buildEmploymentEntries() {
  const cards = document.querySelectorAll('#employmentList .entry-card');
  const entries = [];
  cards.forEach((card) => {
    const entry = {};
    card.querySelectorAll('[data-emp]').forEach((input) => {
      const key = input.getAttribute('data-emp');
      entry[key] = input.value || '';
    });
    if (entry.company || entry.title) entries.push(entry);
  });
  return entries;
}

// ── Education Entries ─────────────────────────────────────────────────────────
function renderEducationEntries(entries = []) {
  const list = document.getElementById('educationList');
  list.innerHTML = '';

  if (entries.length === 0) {
    list.innerHTML = `
      <div class="entry-empty">
        <span>No education added yet</span>
        <button type="button" class="btn-secondary" style="font-size:11px;padding:3px 10px" onclick="addEducationEntry()">+ Add school</button>
      </div>`;
    return;
  }

  entries.forEach((entry, i) => {
    const card = document.createElement('div');
    card.className = 'entry-card';
    card.dataset.index = i;
    card.innerHTML = `
      <div class="entry-card-header">
        <span class="entry-card-title">${escapeHtml(entry.school || `School ${i + 1}`)}</span>
        <button type="button" class="entry-card-remove" title="Remove" onclick="removeEducationEntry(${i})">×</button>
      </div>
      <div class="entry-card-body">
        <div class="field-row">
          <div class="field-group">
            <label>School / University</label>
            <input type="text" data-edu="school" value="${escapeHtml(entry.school || '')}" placeholder="MIT">
          </div>
          <div class="field-group">
            <label>Degree</label>
            <input type="text" data-edu="degree" value="${escapeHtml(entry.degree || '')}" placeholder="Bachelor of Science">
          </div>
        </div>
        <div class="field-row">
          <div class="field-group">
            <label>Field of Study</label>
            <input type="text" data-edu="field" value="${escapeHtml(entry.field || '')}" placeholder="Computer Science">
          </div>
          <div class="field-group">
            <label>Graduation Year</label>
            <input type="text" data-edu="endYear" value="${escapeHtml(entry.endYear || '')}" placeholder="2020">
          </div>
        </div>
      </div>`;
    list.appendChild(card);
  });
}

function addEducationEntry() {
  const profile = buildProfileFromForm();
  profile.education = profile.education || [];
  profile.education.push({ school: '', degree: '', field: '', endYear: '' });
  currentProfile = profile;
  renderEducationEntries(profile.education);
  formDirty = true;
}

function removeEducationEntry(index) {
  const cards = document.querySelectorAll('#educationList .entry-card');
  const card = cards[index];
  if (card) {
    card.style.transition = 'opacity 0.2s, transform 0.2s';
    card.style.opacity = '0';
    card.style.transform = 'scale(0.95)';
    setTimeout(() => {
      const profile = buildProfileFromForm();
      profile.education = profile.education || [];
      profile.education.splice(index, 1);
      currentProfile = profile;
      renderEducationEntries(profile.education);
      formDirty = true;
    }, 200);
  }
}

function buildEducationEntries() {
  const cards = document.querySelectorAll('#educationList .entry-card');
  const entries = [];
  cards.forEach((card) => {
    const entry = {};
    card.querySelectorAll('[data-edu]').forEach((input) => {
      const key = input.getAttribute('data-edu');
      entry[key] = input.value || '';
    });
    if (entry.school || entry.degree) entries.push(entry);
  });
  return entries;
}

// ── Validation ────────────────────────────────────────────────────────────────
function validateProfile(profile) {
  const p = profile.personal || {};
  const errors = [];

  if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) {
    errors.push('Invalid email address');
  }

  if (p.age) {
    const age = parseInt(p.age, 10);
    if (isNaN(age) || age < 1 || age > 120) {
      errors.push('Age must be between 1 and 120');
    }
  }

  if (p.linkedin && !/^https?:\/\//.test(p.linkedin)) {
    errors.push('LinkedIn must be a full URL starting with http:// or https://');
  }

  if (p.website && !/^https?:\/\//.test(p.website)) {
    errors.push('Website must be a full URL starting with http:// or https://');
  }

  return errors;
}

function updateProfileStatus(profile, dirty = false) {
  const el = document.getElementById('profileStatus');
  if (!el) return;

  if (dirty) {
    el.textContent = 'Unsaved changes';
    el.className = 'profile-status profile-status--dirty';
    return;
  }

  if (!profile || Object.keys(profile).length === 0) {
    el.textContent = 'No profile — fill in the form or import a JSON file';
    el.className = 'profile-status profile-status--empty';
    return;
  }

  // Quick sanity check
  const p = profile.personal || {};
  if (!p.firstName && !p.lastName && !p.email) {
    el.textContent = 'Profile incomplete — add at least a name or email';
    el.className = 'profile-status profile-status--error';
    return;
  }

  el.textContent = 'Profile ready';
  el.className = 'profile-status profile-status--ok';
}

// ── Import / Export ───────────────────────────────────────────────────────────
function importProfile() {
  document.getElementById('importFile').click();
}

function handleFileImport(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const parsed = JSON.parse(ev.target.result);
      if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        showStatus('Invalid profile — expected an object', 'error');
        return;
      }
      currentProfile = parsed;
      populateFormFromProfile(parsed);
      updateProfileStatus(parsed);
      formDirty = true;
      showStatus(`Imported: ${file.name}`, 'success');
    } catch (err) {
      showStatus(`Invalid JSON: ${err.message}`, 'error');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

function exportProfile() {
  const profile = buildProfileFromForm();
  const json = JSON.stringify(profile, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sai-profile.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showStatus('Profile exported!', 'success');
}

function toggleJsonMode() {
  jsonMode = !jsonMode;
  const form = document.getElementById('profileForm');
  const jsonWrap = document.getElementById('profileJsonWrap');
  const toggleBtn = document.getElementById('toggleJsonBtn');

  if (jsonMode) {
    // Sync form → JSON
    const profile = buildProfileFromForm();
    document.getElementById('profileJson').value = JSON.stringify(profile, null, 2);
    form.hidden = true;
    jsonWrap.hidden = false;
    toggleBtn.textContent = 'Form';
  } else {
    // Sync JSON → form
    const ta = document.getElementById('profileJson');
    try {
      const parsed = JSON.parse(ta.value);
      currentProfile = parsed;
      populateFormFromProfile(parsed);
      updateProfileStatus(parsed);
    } catch (_) {
      updateProfileStatus(null);
    }
    form.hidden = false;
    jsonWrap.hidden = true;
    toggleBtn.textContent = 'JSON';
  }
}

// ── Misc ───────────────────────────────────────────────────────────────────────
function showStatus(msg, type) {
  const el = document.getElementById('saveStatus');
  if (el) {
    el.textContent = msg;
    el.className = `save-status ${type}`;
    setTimeout(() => { el.textContent = ''; }, 3000);
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
