import {
    getSettings,
    saveSettings,
    login,
    me,
    listProfiles,
    normalizeBaseUrl
} from './lib/api.js';

const $ = (id) => document.getElementById(id);

function show(el, on) {
    el.classList.toggle('hidden', !on);
}

function setPill(text, kind = 'muted') {
    const pill = $('statusPill');
    pill.textContent = text;
    pill.className = `pill ${kind}`;
}

async function refresh() {
    $('loginError').textContent = '';
    $('mainError').textContent = '';
    $('mainOk').textContent = '';

    const settings = await getSettings();
    $('apiBaseUrl').value = settings.apiBaseUrl;
    $('frontendBaseUrl').value = settings.frontendBaseUrl;
    $('autoSubmit').checked = !!settings.autoSubmit;

    try {
        const { lastUiMessage } = await chrome.storage.local.get(['lastUiMessage']);
        if (lastUiMessage?.message || lastUiMessage?.short) {
            const age = Date.now() - new Date(lastUiMessage.at).getTime();
            if (age < 10 * 60 * 1000) {
                const line = lastUiMessage.short
                    || `${lastUiMessage.title}: ${lastUiMessage.message}`;
                if (lastUiMessage.kind === 'error') {
                    $('mainError').textContent = line;
                } else {
                    $('mainOk').textContent = line;
                }
            }
        }
    } catch (_) { /* ignore */ }

    if (!settings.token) {
        show($('viewLogin'), true);
        show($('viewMain'), false);
        setPill('Logged out', 'muted');
        return;
    }

    try {
        const user = await me();
        await saveSettings({ user });
        show($('viewLogin'), false);
        show($('viewMain'), true);
        $('userName').textContent = user.username;
        setPill('Connected', 'ok');
        await loadProfiles(settings.selectedProfileId);
        renderLast(settings.lastResult);
        await refreshMonitor();
    } catch (err) {
        if (err.status === 401) {
            await saveSettings({
                token: null,
                user: null,
                selectedProfileId: null,
                selectedProfileName: null
            });
            show($('viewLogin'), true);
            show($('viewMain'), false);
            setPill('Session expired', 'warn');
            $('loginError').textContent = 'Session expired — log in again.';
            return;
        }
        show($('viewLogin'), true);
        show($('viewMain'), false);
        setPill('API error', 'warn');
        $('loginError').textContent = err.message || 'Could not reach API';
    }
}

async function loadProfiles(selectedId) {
    const profiles = await listProfiles();
    const select = $('profileSelect');
    select.innerHTML = '';

    if (!Array.isArray(profiles) || profiles.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No profiles assigned';
        select.appendChild(opt);
        return;
    }

    let chosen = selectedId;
    if (!chosen) {
        const def = profiles.find((p) => p.is_default) || profiles[0];
        chosen = def?.id;
    }

    for (const p of profiles) {
        const opt = document.createElement('option');
        opt.value = String(p.id);
        opt.textContent = `${p.first_name} ${p.last_name}${p.is_default ? ' (default)' : ''}`;
        if (Number(p.id) === Number(chosen)) opt.selected = true;
        select.appendChild(opt);
    }
}

function renderLast(last) {
    const box = $('lastBox');
    const summary = $('lastSummary');
    const link = $('lastDownload');
    if (!last) {
        show(box, false);
        return;
    }
    show(box, true);
    if (last.error) {
        summary.textContent = `Error: ${last.error}`;
        show(link, false);
        return;
    }
    const fill = last.fillStats
        ? ` · filled ${last.fillStats.filled}, uploaded ${last.fillStats.uploaded}` +
          (last.fillStats.markedApplied ? ', marked applied' : '')
        : '';
    summary.textContent = [
        last.applicationId ? `App #${last.applicationId}` : null,
        last.profileName,
        last.company || last.jobTitle,
        last.autoPassed ? 'auto-passed' : (last.fromMode2 ? 'mode2' : ''),
        last.at ? new Date(last.at).toLocaleString() : ''
    ].filter(Boolean).join(' · ') + fill;

    if (last.downloadUrl) {
        link.href = last.downloadUrl;
        show(link, true);
    } else {
        show(link, false);
    }
}

async function refreshMonitor() {
    const summary = $('monitorSummary');
    const list = $('readyList');
    list.innerHTML = '';
    summary.textContent = 'Loading…';

    chrome.runtime.sendMessage({ type: 'BIDDER_STATUS' }, (statusRes) => {
        if (!statusRes?.ok) {
            summary.textContent = statusRes?.error || 'Status unavailable';
            return;
        }
        const s = statusRes.data || {};
        const caps = s.caps || {};
        const today = s.today || {};
        summary.textContent =
            `Ready: ${s.ready_count || 0} · Today: ${today.userTotal ?? '—'} ` +
            `(caps ${caps.maxPerProfilePerDay || 100}/profile, ${caps.maxTotalPerDay || 500}/day)`;
    });

    chrome.runtime.sendMessage({ type: 'BIDDER_QUEUE_STATE' }, (qs) => {
        if (qs?.ok && qs.data?.status) {
            const st = qs.data;
            let extra = ` · Queue: ${st.status}`
                + (st.index ? ` ${st.index}/${st.total || '?'}` : '');
            if (st.status === 'awaiting_captcha') {
                extra += st.captchaKind === 'login'
                    ? ' — log in on the apply tab, then Resume'
                    : ' — solve CAPTCHA on the apply tab, then Resume';
            }
            summary.textContent += extra;
        }
    });

    chrome.runtime.sendMessage({ type: 'LIST_READY' }, (readyRes) => {
        if (!readyRes?.ok) {
            list.innerHTML = `<div class="small muted">${readyRes?.error || 'Queue unavailable'}</div>`;
            return;
        }
        const items = readyRes.data?.items || [];
        if (!items.length) {
            list.innerHTML = '<div class="small muted">No ready applications for this profile.</div>';
            return;
        }
        for (const item of items.slice(0, 8)) {
            const row = document.createElement('div');
            row.className = 'ready-item';
            row.innerHTML = `
              <div class="strong small">${item.company_name || 'Company'} — ${item.job_role || 'Role'}</div>
              <div class="muted small">${item.first_name || ''} ${item.last_name || ''}</div>
            `;
            const btn = document.createElement('button');
            btn.className = 'btn secondary';
            btn.textContent = item.open_url ? 'Open + fill' : 'No apply URL';
            btn.disabled = !item.open_url;
            btn.addEventListener('click', () => {
                chrome.runtime.sendMessage({ type: 'OPEN_READY', item }, (res) => {
                    if (!res?.ok) {
                        $('mainError').textContent = res?.error || 'Open failed';
                    } else {
                        $('mainOk').textContent = 'Opened — bidder full fill when form appears';
                        window.close();
                    }
                });
            });
            row.appendChild(btn);
            list.appendChild(row);
        }
    });
}

$('btnProcessQueue')?.addEventListener('click', () => {
    $('mainError').textContent = '';
    $('mainOk').textContent = 'Starting bidder queue…';
    chrome.runtime.sendMessage({ type: 'PROCESS_READY_QUEUE' }, (res) => {
        if (!res?.ok) {
            $('mainError').textContent = res?.error || 'Queue failed';
            $('mainOk').textContent = '';
        } else {
            $('mainOk').textContent = res.started
                ? 'Queue started — watch Bid Courses / open tabs'
                : `Queue done — processed ${res.result?.processed ?? 0}`;
            refreshMonitor();
        }
    });
});

$('btnBidderNext')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'BIDDER_NEXT' }, (res) => {
        $('mainOk').textContent = res?.ok ? 'Next — continuing queue' : (res?.error || 'Next failed');
    });
});

$('btnCaptchaResume')?.addEventListener('click', () => {
    $('mainError').textContent = '';
    chrome.runtime.sendMessage({ type: 'BIDDER_CAPTCHA_RESUME', force: true }, (res) => {
        if (!res?.ok) $('mainError').textContent = res?.error || 'Resume failed';
        else {
            $('mainOk').textContent = 'CAPTCHA resume signaled — queue continues';
            refreshMonitor();
        }
    });
});

$('btnBidderStop')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'BIDDER_STOP' }, (res) => {
        $('mainOk').textContent = res?.ok ? 'Queue stop requested' : (res?.error || 'Stop failed');
    });
});

$('btnSubmittedOk')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'SUBMITTED_OK' }, (res) => {
        if (!res?.ok) $('mainError').textContent = res?.error || 'Mark failed';
        else $('mainOk').textContent = 'Marked applied + tab closed';
    });
});

$('btnOpenCourses')?.addEventListener('click', async () => {
    const settings = await getSettings();
    const url = `${settings.frontendBaseUrl}/user/bid-courses`;
    chrome.tabs.create({ url });
});

function settingsPathForRole(role) {
    const r = String(role || 'user').toLowerCase();
    if (r === 'admin') return '/admin/autofill-settings';
    if (r === 'manager') return '/manager/autofill-settings';
    if (r === 'caller') return '/caller/settings';
    if (r === 'developer') return '/developer/settings';
    return '/user/autofill-settings';
}

$('btnOpenLumiSettings')?.addEventListener('click', async () => {
    const settings = await getSettings();
    const path = settingsPathForRole(settings.user?.role);
    const url = `${settings.frontendBaseUrl}${path}#lumi-bidder-settings`;
    chrome.tabs.create({ url });
});

$('btnLogin').addEventListener('click', async () => {
    $('loginError').textContent = '';
    const apiBaseUrl = normalizeBaseUrl($('apiBaseUrl').value);
    const frontendBaseUrl = normalizeBaseUrl($('frontendBaseUrl').value || 'http://127.0.0.1:5173');
    const username = $('username').value.trim();
    const password = $('password').value;
    if (!username || !password) {
        $('loginError').textContent = 'Username and password required';
        return;
    }
    $('btnLogin').disabled = true;
    try {
        await login(username, password, apiBaseUrl);
        await saveSettings({ frontendBaseUrl });
        $('password').value = '';
        await refresh();
    } catch (err) {
        $('loginError').textContent = err.message || 'Login failed';
    } finally {
        $('btnLogin').disabled = false;
    }
});

$('btnLogout').addEventListener('click', async () => {
    await saveSettings({
        token: null,
        user: null,
        selectedProfileId: null,
        selectedProfileName: null
    });
    await refresh();
});

$('autoSubmit').addEventListener('change', async (e) => {
    await saveSettings({ autoSubmit: !!e.target.checked });
    $('mainOk').textContent = e.target.checked
        ? 'Auto-Submit ON — use carefully'
        : 'Auto-Submit OFF — you click Submit';
});

$('btnSaveProfile').addEventListener('click', async () => {
    $('mainError').textContent = '';
    $('mainOk').textContent = '';
    const select = $('profileSelect');
    if (!select.value) {
        $('mainError').textContent = 'Select a profile';
        return;
    }
    await saveSettings({
        selectedProfileId: Number(select.value),
        selectedProfileName: select.options[select.selectedIndex]?.textContent || ''
    });
    $('mainOk').textContent = `Saved: ${select.options[select.selectedIndex]?.textContent}`;
});

async function ensureProfileSaved() {
    const settings = await getSettings();
    if (settings.selectedProfileId) return true;
    const select = $('profileSelect');
    if (!select.value) {
        $('mainError').textContent = 'Choose and save a bid profile first';
        return false;
    }
    await saveSettings({
        selectedProfileId: Number(select.value),
        selectedProfileName: select.options[select.selectedIndex]?.textContent || ''
    });
    return true;
}

$('btnGenerate').addEventListener('click', async () => {
    $('mainError').textContent = '';
    $('mainOk').textContent = '';
    if (!(await ensureProfileSaved())) return;
    $('btnGenerate').disabled = true;
    $('mainOk').textContent = 'Opening Generate page with JD…';
    setPill('Working…', 'warn');
    // Persist frontend URL if user changed it while logged in
    await saveSettings({
        frontendBaseUrl: normalizeBaseUrl($('frontendBaseUrl')?.value || (await getSettings()).frontendBaseUrl)
    });
    chrome.runtime.sendMessage({ type: 'RUN_BID_GENERATE', alsoFill: false }, async (response) => {
        $('btnGenerate').disabled = false;
        if (chrome.runtime.lastError) {
            $('mainError').textContent = chrome.runtime.lastError.message;
            setPill('Error', 'warn');
            return;
        }
        if (!response?.ok) {
            $('mainError').textContent = response?.error || 'Failed';
            $('mainOk').textContent = '';
            setPill('Failed', 'warn');
            renderLast((await getSettings()).lastResult);
            return;
        }
        $('mainOk').textContent = 'Generate page opened — watch “Generating…” in the app';
        setPill('Connected', 'ok');
        renderLast(response.result);
        await refreshMonitor();
    });
});

$('btnFill').addEventListener('click', async () => {
    $('mainError').textContent = '';
    $('mainOk').textContent = '';
    if (!(await ensureProfileSaved())) return;
    $('btnFill').disabled = true;
    $('mainOk').textContent = 'Autofill profile… (keep popup open a moment)';
    chrome.runtime.sendMessage({ type: 'RUN_PROFILE_AUTOFILL' }, async (response) => {
        $('btnFill').disabled = false;
        if (chrome.runtime.lastError) {
            $('mainError').textContent = chrome.runtime.lastError.message;
            $('mainOk').textContent = '';
            return;
        }
        if (!response?.ok) {
            $('mainError').textContent = response?.error || 'Autofill failed';
            $('mainOk').textContent = '';
            return;
        }
        $('mainOk').textContent =
            `Autofilled ${response.result?.filled || 0}`
            + (response.result?.uploaded ? `, uploaded resume` : '')
            + (response.result?.questions ? ` · ${response.result.questions} need Answer questions` : '');
        if ((response.result?.filled || 0) + (response.result?.uploaded || 0) === 0) {
            $('mainError').textContent =
                '0 fields filled — stay on the ATS apply tab, then click Autofill again.';
        }
        await refreshMonitor();
    });
});

$('btnAnswerQs').addEventListener('click', async () => {
    $('mainError').textContent = '';
    $('mainOk').textContent = '';
    if (!(await ensureProfileSaved())) return;
    $('btnAnswerQs').disabled = true;
    $('mainOk').textContent = 'Answer questions… (Generate CV first)';
    chrome.runtime.sendMessage({ type: 'RUN_ANSWER_QUESTIONS' }, async (response) => {
        $('btnAnswerQs').disabled = false;
        if (chrome.runtime.lastError) {
            $('mainError').textContent = chrome.runtime.lastError.message;
            $('mainOk').textContent = '';
            return;
        }
        if (!response?.ok) {
            $('mainError').textContent = response?.error || 'Answer questions failed';
            $('mainOk').textContent = '';
            return;
        }
        $('mainOk').textContent =
            `AI answers filled: ${response.result?.answers || 0}`;
        await refreshMonitor();
    });
});

$('btnMarkApplied').addEventListener('click', async () => {
    $('mainError').textContent = '';
    $('mainOk').textContent = '';
    const settings = await getSettings();
    const id = settings.lastResult?.applicationId;
    if (!id) {
        $('mainError').textContent = 'No application on last result';
        return;
    }
    chrome.runtime.sendMessage({ type: 'MARK_APPLIED', applicationId: id }, async (res) => {
        if (!res?.ok) {
            $('mainError').textContent = res?.error || 'Mark applied failed';
            return;
        }
        $('mainOk').textContent = `Marked applied (#${id})`;
        await refreshMonitor();
    });
});

$('btnRefreshReady').addEventListener('click', () => refreshMonitor());

$('btnConnectJobLinks')?.addEventListener('click', () => {
    $('mainError').textContent = '';
    $('mainOk').textContent = 'Connecting Job Links tab…';
    chrome.runtime.sendMessage({ type: 'CONNECT_JOB_LINKS' }, (res) => {
        const err = chrome.runtime.lastError;
        if (err) {
            $('mainOk').textContent = '';
            $('mainError').textContent = err.message || 'Connect failed';
            return;
        }
        if (!res?.ok) {
            $('mainOk').textContent = '';
            $('mainError').textContent = res?.error || 'No Job Links tab found — open http://127.0.0.1:5173/admin/job-links first';
            return;
        }
        $('mainOk').textContent =
            `Connected ${res.injected || 0} tab(s) · Lumi v${res.version || '?'}. Open Lumi → Check Lumi.`;
    });
});

refresh();
