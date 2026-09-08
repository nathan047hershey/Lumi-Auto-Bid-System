/**
 * Shared browser harness for autofill fixture tests.
 */
const fs = require('fs');
const path = require('path');

async function loadPuppeteer() {
    for (const c of [
        path.join(__dirname, '../../../server/node_modules/puppeteer-core'),
        path.join(__dirname, '../../../server/node_modules/puppeteer'),
        'puppeteer-core'
    ]) {
        try { return require(c); } catch (_) { /* ignore */ }
    }
    return null;
}

function chromePath() {
    return [
        process.env.CHROME_PATH,
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ].filter(Boolean).find((p) => fs.existsSync(p));
}

function loadFillScript() {
    const cm = fs.readFileSync(path.join(__dirname, '../../content/controlMatch.js'), 'utf8');
    const fill = fs.readFileSync(path.join(__dirname, '../../content/fill.js'), 'utf8');
    return `${cm}\n${fill}`;
}

async function injectAutofill(page, fillSrc, { spoofHost = '' } = {}) {
    await page.evaluate((host) => {
        if (host) {
            window.__BIDDER_SPOOF_HOST = host;
            window.__BIDDER_SPOOF_HREF = `https://${host}/apply`;
        }
        window.__chromeListeners = [];
        window.chrome = {
            runtime: {
                id: 'fixture-test',
                onMessage: { addListener(fn) { window.__chromeListeners.push(fn); } },
                sendMessage() {},
                lastError: null
            }
        };
    }, spoofHost || '');
    await page.addScriptTag({ content: fillSrc });
}

async function collectAndFill(page, { profile, jobDescription = '', answers = [], waitMs = 8000 }) {
    return page.evaluate(async (profile, jd, answers, waitMs) => {
        const listeners = window.__chromeListeners || [];
        const send = (msg) => new Promise((resolve) => {
            let done = false;
            const respond = (p) => { if (!done) { done = true; resolve(p); } };
            for (const fn of listeners) {
                if (fn(msg, {}, respond) === true) return;
            }
            setTimeout(() => { if (!done) resolve({ ok: false, error: 'timeout' }); }, 120);
        });

        const collect = await send({ type: 'COLLECT_FORM' });
        if (!collect?.ok) return { error: 'collect', collect };

        const fill = await send({
            type: 'FILL_FORM',
            payload: {
                fields: collect.data.fields,
                answers,
                profile,
                jobDescription: jd
            }
        });

        await new Promise((r) => setTimeout(r, waitMs));

        return {
            ats: collect.data.ats,
            fields: (collect.data.fields || []).map((f) => ({
                id: f.id,
                label: f.label,
                kind: f.kind,
                combobox: !!f.combobox
            })),
            fillStats: fill?.fillStats || {},
            fillOk: fill?.ok
        };
    }, profile, jobDescription, answers, waitMs);
}

function sv(id) {
    return `(function(id){
      const v=document.getElementById(id+'-val');
      const p=document.getElementById(id+'-ph');
      if(v&&v.textContent&&!/^select/i.test(v.textContent.trim())) return v.textContent.trim();
      if(p&&p.style.display!=='none'&&p.textContent) return '';
      return document.getElementById(id)?.value||'';
    })('${id}')`;
}

module.exports = {
    loadPuppeteer,
    chromePath,
    loadFillScript,
    injectAutofill,
    collectAndFill,
    sv
};
