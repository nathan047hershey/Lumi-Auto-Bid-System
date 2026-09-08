/**
 * Built-in CAPTCHA token solvers — CapSolver + 2Captcha (high-success path).
 * Multi-strategy: better extraction → task-type fallbacks → dual provider → strong inject.
 */
const CAPSOLVER_CREATE = 'https://api.capsolver.com/createTask';
const CAPSOLVER_RESULT = 'https://api.capsolver.com/getTaskResult';
const TWOCAPTCHA_IN = 'https://api.2captcha.com/in.php';
const TWOCAPTCHA_RES = 'https://api.2captcha.com/res.php';

/** Vendors we attempt via paid API (not login walls / full CF interstitial). */
const SOLVABLE = new Set([
    'recaptcha',
    'recaptcha_v3',
    'hcaptcha',
    'turnstile',
    'arkose',
    'geetest',
    'aws_waf'
]);

export function isSolvableVendor(vendor) {
    const v = String(vendor || '').toLowerCase();
    if (SOLVABLE.has(v)) return true;
    if (v === 'funcaptcha') return true;
    return false;
}

/**
 * Prefer CapSolver when key set; else 2Captcha.
 * @returns {'capsolver'|'2captcha'|null}
 */
export function resolveSolverProvider(prefs = {}) {
    if (String(prefs.capsolverApiKey || '').trim()) return 'capsolver';
    if (String(prefs.twocaptchaApiKey || '').trim()) return '2captcha';
    return null;
}

async function postJson(url, body, timeoutMs = 60000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: ctrl.signal
        });
        const data = await res.json().catch(() => ({}));
        return { ok: res.ok, status: res.status, data };
    } finally {
        clearTimeout(t);
    }
}

async function sleep(ms) {
    await new Promise((r) => setTimeout(r, ms));
}

export function capsolverTaskType(vendor, {
    enterprise = false,
    v3 = false
} = {}) {
    const v = String(vendor || '').toLowerCase();
    if (v === 'hcaptcha') return 'HCaptchaTaskProxyLess';
    if (v === 'turnstile') return 'AntiTurnstileTaskProxyLess';
    if (v === 'arkose' || v === 'funcaptcha') return 'FunCaptchaTaskProxyLess';
    if (v === 'geetest') return 'GeeTestTaskProxyLess';
    if (v === 'aws_waf') return 'AntiAwsWafTaskProxyLess';
    if (v === 'recaptcha_v3' || v3) {
        return enterprise
            ? 'ReCaptchaV3EnterpriseTaskProxyLess'
            : 'ReCaptchaV3TaskProxyLess';
    }
    if (enterprise) return 'ReCaptchaV2EnterpriseTaskProxyLess';
    return 'ReCaptchaV2TaskProxyLess';
}

export function extractToken(solution, vendor) {
    if (!solution || typeof solution !== 'object') return '';
    const v = String(vendor || '').toLowerCase();
    if (v === 'hcaptcha') {
        return String(solution.gRecaptchaResponse || solution.token || solution.respKey || '').trim();
    }
    if (v === 'turnstile' || v === 'aws_waf') {
        return String(solution.token || solution.gRecaptchaResponse || solution.cookie || '').trim();
    }
    if (v === 'arkose' || v === 'funcaptcha') {
        return String(solution.token || solution.gRecaptchaResponse || '').trim();
    }
    if (v === 'geetest') {
        // Often JSON blob of challenge/validate/seccode
        if (solution.captcha_id || solution.lot_number) {
            try { return JSON.stringify(solution); } catch { /* fall through */ }
        }
        return String(solution.token || solution.gRecaptchaResponse || '').trim();
    }
    return String(solution.gRecaptchaResponse || solution.token || '').trim();
}

/**
 * Ordered CapSolver/2Captcha attempt plans from page signals.
 * Trying multiple task types is the main lift for success rate.
 */
export function buildSolveAttempts(target = {}, wall = {}) {
    const pageUrl = target.pageUrl || '';
    const keys = [];
    const pushKey = (k) => {
        const s = String(k || '').trim();
        if (s && s.length >= 8 && !keys.includes(s)) keys.push(s);
    };
    pushKey(target.sitekey);
    for (const k of target.sitekeys || []) pushKey(k);
    pushKey(target.arkosePublicKey);
    pushKey(target.geetestCaptchaId || target.geetestGt);

    if (!keys.length && target.websiteKey) pushKey(target.websiteKey);

    let vendor = String(wall?.vendor || target.vendor || 'recaptcha').toLowerCase();
    if (vendor === 'funcaptcha') vendor = 'arkose';
    if (vendor === 'generic' || vendor === 'none' || vendor === 'cloudflare') {
        vendor = target.vendor || 'recaptcha';
    }
    if (!isSolvableVendor(vendor) && isSolvableVendor(target.vendor)) {
        vendor = String(target.vendor).toLowerCase();
    }

    const enterprise = !!(target.enterprise || wall?.enterprise);
    const invisible = !!(target.invisible);
    const action = String(target.action || target.pageAction || '').trim();
    const v3Hint = !!(target.v3 || vendor === 'recaptcha_v3' || (action && /recaptcha/i.test(vendor)));
    const attempts = [];

    const add = (partial) => {
        const websiteKey = partial.websiteKey || keys[0];
        if (!websiteKey && !partial.allowEmptyKey) return;
        attempts.push({
            vendor: partial.vendor || vendor,
            websiteURL: pageUrl,
            websiteKey,
            enterprise: !!partial.enterprise,
            invisible: !!partial.invisible,
            pageAction: partial.pageAction || action || '',
            v3: !!partial.v3,
            taskType: partial.taskType || null,
            arkosePublicKey: partial.arkosePublicKey || target.arkosePublicKey || '',
            geetestCaptchaId: partial.geetestCaptchaId || target.geetestCaptchaId || '',
            geetestGt: partial.geetestGt || target.geetestGt || '',
            geetestChallenge: partial.geetestChallenge || target.geetestChallenge || '',
            awsKey: target.awsKey || '',
            awsIv: target.awsIv || '',
            awsContext: target.awsContext || '',
            userAgent: target.userAgent || '',
            label: partial.label || partial.taskType || partial.vendor || vendor
        });
    };

    if (vendor === 'hcaptcha') {
        for (const k of keys) add({ vendor: 'hcaptcha', websiteKey: k, label: 'hcaptcha' });
    } else if (vendor === 'turnstile') {
        for (const k of keys) {
            add({ vendor: 'turnstile', websiteKey: k, pageAction: action, label: 'turnstile' });
        }
    } else if (vendor === 'arkose') {
        const pk = target.arkosePublicKey || keys[0];
        if (pk) {
            add({
                vendor: 'arkose',
                websiteKey: pk,
                arkosePublicKey: pk,
                taskType: 'FunCaptchaTaskProxyLess',
                label: 'arkose'
            });
        }
    } else if (vendor === 'geetest') {
        add({
            vendor: 'geetest',
            websiteKey: target.geetestCaptchaId || target.geetestGt || keys[0],
            geetestCaptchaId: target.geetestCaptchaId,
            geetestGt: target.geetestGt,
            geetestChallenge: target.geetestChallenge,
            taskType: 'GeeTestTaskProxyLess',
            label: 'geetest'
        });
    } else if (vendor === 'aws_waf' && (target.awsKey || keys[0])) {
        add({
            vendor: 'aws_waf',
            websiteKey: target.awsKey || keys[0],
            taskType: 'AntiAwsWafTaskProxyLess',
            label: 'aws_waf'
        });
    } else {
        // reCAPTCHA family — try high-probability variants in order
        const keyList = keys.length ? keys : [''];
        for (const k of keyList) {
            if (!k) continue;
            if (enterprise || target.enterprise) {
                add({
                    vendor: 'recaptcha',
                    websiteKey: k,
                    enterprise: true,
                    invisible,
                    label: 'recaptcha_v2_enterprise'
                });
            }
            if (v3Hint || vendor === 'recaptcha_v3') {
                add({
                    vendor: 'recaptcha_v3',
                    websiteKey: k,
                    v3: true,
                    enterprise: false,
                    pageAction: action || 'submit',
                    label: 'recaptcha_v3'
                });
                if (enterprise) {
                    add({
                        vendor: 'recaptcha_v3',
                        websiteKey: k,
                        v3: true,
                        enterprise: true,
                        pageAction: action || 'submit',
                        label: 'recaptcha_v3_enterprise'
                    });
                }
            }
            add({
                vendor: 'recaptcha',
                websiteKey: k,
                enterprise: false,
                invisible,
                label: invisible ? 'recaptcha_v2_invisible' : 'recaptcha_v2'
            });
            // Flip invisible if first guess wrong
            if (invisible) {
                add({
                    vendor: 'recaptcha',
                    websiteKey: k,
                    enterprise: false,
                    invisible: false,
                    label: 'recaptcha_v2_visible_fallback'
                });
            } else {
                add({
                    vendor: 'recaptcha',
                    websiteKey: k,
                    enterprise: false,
                    invisible: true,
                    label: 'recaptcha_v2_invisible_fallback'
                });
            }
            if (!enterprise) {
                add({
                    vendor: 'recaptcha',
                    websiteKey: k,
                    enterprise: true,
                    invisible,
                    label: 'recaptcha_v2_enterprise_fallback'
                });
            }
            if (!v3Hint) {
                add({
                    vendor: 'recaptcha_v3',
                    websiteKey: k,
                    v3: true,
                    pageAction: action || 'submit',
                    label: 'recaptcha_v3_fallback'
                });
            }
        }
    }

    // De-dupe by label+key+enterprise+invisible+v3
    const seen = new Set();
    return attempts.filter((a) => {
        const id = `${a.label}|${a.websiteKey}|${a.enterprise}|${a.invisible}|${a.v3}|${a.taskType}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
    }).slice(0, 10); // cap cost/time
}

/**
 * CapSolver single attempt (one task type).
 */
export async function solveWithCapSolver({
    apiKey,
    vendor,
    websiteURL,
    websiteKey,
    enterprise = false,
    invisible = false,
    pageAction = '',
    v3 = false,
    taskType = null,
    arkosePublicKey = '',
    geetestCaptchaId = '',
    geetestGt = '',
    geetestChallenge = '',
    awsKey = '',
    awsIv = '',
    awsContext = '',
    userAgent = '',
    timeoutMs = 120000
} = {}) {
    const key = String(apiKey || '').trim();
    if (!key) return { ok: false, error: 'missing_capsolver_key' };
    if (!websiteURL) return { ok: false, error: 'missing_sitekey_or_url' };

    const type = taskType || capsolverTaskType(vendor, { enterprise, v3 });
    const task = { type, websiteURL };

    if (type.startsWith('FunCaptcha')) {
        task.websitePublicKey = arkosePublicKey || websiteKey;
        if (!task.websitePublicKey) return { ok: false, error: 'missing_arkose_public_key', provider: 'capsolver' };
    } else if (type.startsWith('GeeTest')) {
        if (geetestCaptchaId) {
            task.captchaId = geetestCaptchaId;
        } else {
            task.gt = geetestGt || websiteKey;
            if (geetestChallenge) task.challenge = geetestChallenge;
        }
        if (!task.captchaId && !task.gt) {
            return { ok: false, error: 'missing_geetest_id', provider: 'capsolver' };
        }
    } else if (type.startsWith('AntiAwsWaf')) {
        task.awsKey = awsKey || websiteKey;
        if (awsIv) task.awsIv = awsIv;
        if (awsContext) task.awsContext = awsContext;
        if (!task.awsKey) return { ok: false, error: 'missing_aws_waf_key', provider: 'capsolver' };
    } else {
        if (!websiteKey) return { ok: false, error: 'missing_sitekey_or_url' };
        task.websiteKey = websiteKey;
        if (invisible && /ReCaptchaV2/i.test(type)) task.isInvisible = true;
        if (pageAction && /ReCaptchaV3|Turnstile|AntiTurnstile/i.test(type)) {
            if (/Turnstile/i.test(type)) task.metadata = { action: pageAction };
            else task.pageAction = pageAction;
        } else if (pageAction && /ReCaptchaV2/i.test(type)) {
            /* v2 usually ignores pageAction */
        }
        if (/ReCaptchaV3/i.test(type) && !task.pageAction) {
            task.pageAction = pageAction || 'submit';
        }
    }
    if (userAgent) task.userAgent = userAgent;

    let created;
    try {
        created = await postJson(CAPSOLVER_CREATE, { clientKey: key, task });
    } catch (err) {
        return {
            ok: false,
            error: err?.name === 'AbortError' ? 'capsolver_create_timeout' : (err?.message || 'capsolver_create_network'),
            provider: 'capsolver',
            taskType: type
        };
    }
    if (created.data?.errorId && created.data.errorId !== 0) {
        return {
            ok: false,
            error: created.data.errorDescription || created.data.errorCode || 'capsolver_create_failed',
            provider: 'capsolver',
            taskType: type
        };
    }
    if (created.data?.status === 'ready' && created.data?.solution) {
        const token = extractToken(created.data.solution, vendor);
        if (token) {
            return {
                ok: true,
                token,
                provider: 'capsolver',
                vendor,
                taskType: type,
                solution: created.data.solution
            };
        }
    }
    const taskId = created.data?.taskId;
    if (!taskId) {
        return { ok: false, error: 'capsolver_no_task_id', provider: 'capsolver', taskType: type, raw: created.data };
    }

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        await sleep(2500);
        let polled;
        try {
            polled = await postJson(CAPSOLVER_RESULT, { clientKey: key, taskId });
        } catch (_) {
            continue;
        }
        if (polled.data?.errorId && polled.data.errorId !== 0) {
            return {
                ok: false,
                error: polled.data.errorDescription || polled.data.errorCode || 'capsolver_poll_failed',
                provider: 'capsolver',
                taskType: type
            };
        }
        if (polled.data?.status === 'ready') {
            const token = extractToken(polled.data.solution, vendor);
            if (token) {
                return {
                    ok: true,
                    token,
                    provider: 'capsolver',
                    vendor,
                    taskId,
                    taskType: type,
                    solution: polled.data.solution
                };
            }
            return { ok: false, error: 'capsolver_empty_token', provider: 'capsolver', taskType: type, raw: polled.data };
        }
    }
    return { ok: false, error: 'capsolver_timeout', provider: 'capsolver', taskId, taskType: type };
}

/**
 * 2Captcha single attempt.
 */
export async function solveWith2Captcha({
    apiKey,
    vendor,
    websiteURL,
    websiteKey,
    invisible = false,
    pageAction = '',
    v3 = false,
    enterprise = false,
    arkosePublicKey = '',
    geetestGt = '',
    geetestChallenge = '',
    timeoutMs = 120000
} = {}) {
    const key = String(apiKey || '').trim();
    if (!key) return { ok: false, error: 'missing_2captcha_key' };
    if (!websiteURL || !websiteKey) return { ok: false, error: 'missing_sitekey_or_url' };

    const v = String(vendor || '').toLowerCase();
    let method = 'userrecaptcha';
    if (v === 'hcaptcha') method = 'hcaptcha';
    else if (v === 'turnstile') method = 'turnstile';
    else if (v === 'arkose' || v === 'funcaptcha') method = 'funcaptcha';
    else if (v === 'geetest') method = 'geetest';

    const params = new URLSearchParams({
        key,
        method,
        pageurl: websiteURL,
        json: '1'
    });
    if (method === 'funcaptcha') {
        params.set('publickey', arkosePublicKey || websiteKey);
    } else if (method === 'geetest') {
        params.set('gt', geetestGt || websiteKey);
        if (geetestChallenge) params.set('challenge', geetestChallenge);
    } else {
        params.set('googlekey', websiteKey);
        params.set('sitekey', websiteKey);
    }
    if (invisible) params.set('invisible', '1');
    if (v3 || v === 'recaptcha_v3') {
        params.set('version', 'v3');
        params.set('action', pageAction || 'submit');
        params.set('min_score', '0.7');
    }
    if (enterprise) params.set('enterprise', '1');

    let createRes;
    try {
        createRes = await fetch(`${TWOCAPTCHA_IN}?${params.toString()}`).then((r) => r.json());
    } catch (err) {
        return {
            ok: false,
            error: err?.message || '2captcha_create_network',
            provider: '2captcha'
        };
    }
    if (!createRes || createRes.status !== 1 || !createRes.request) {
        return {
            ok: false,
            error: createRes?.request || createRes?.error_text || '2captcha_create_failed',
            provider: '2captcha'
        };
    }
    const requestId = createRes.request;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        await sleep(4000);
        let polled;
        try {
            const pollUrl = `${TWOCAPTCHA_RES}?key=${encodeURIComponent(key)}&action=get&id=${encodeURIComponent(requestId)}&json=1`;
            polled = await fetch(pollUrl).then((r) => r.json());
        } catch (_) {
            continue;
        }
        if (!polled) continue;
        if (polled.status === 1 && polled.request) {
            return { ok: true, token: String(polled.request), provider: '2captcha', vendor, taskId: requestId };
        }
        const req = String(polled.request || '');
        if (req && req !== 'CAPCHA_NOT_READY') {
            return { ok: false, error: req, provider: '2captcha' };
        }
    }
    return { ok: false, error: '2captcha_timeout', provider: '2captcha', taskId: requestId };
}

/**
 * Page-world: rich sitekey + vendor extraction (MAIN world).
 */
export function extractCaptchaTargetInPage() {
    const pageUrl = location.href;
    const userAgent = navigator.userAgent || '';
    const html = document.documentElement?.innerHTML || '';
    const sitekeys = [];
    const push = (k) => {
        const s = String(k || '').trim();
        if (s && s.length >= 8 && !sitekeys.includes(s)) sitekeys.push(s);
    };

    const pickAll = (sel, attr = 'data-sitekey') => {
        document.querySelectorAll(sel).forEach((el) => {
            push(el.getAttribute(attr) || el.dataset?.sitekey || el.getAttribute('data-pkey'));
        });
    };
    pickAll('.g-recaptcha, #g-recaptcha, [data-sitekey].g-recaptcha, [data-sitekey]');
    pickAll('.h-captcha, [class*="h-captcha"]');
    pickAll('.cf-turnstile, [class*="cf-turnstile"]');
    pickAll('[data-pkey], .arkose-container, #arkose, [data-callback]');

    const iframeSrc = [...document.querySelectorAll('iframe')].map((f) => f.src || '').join('\n');
    for (const m of iframeSrc.matchAll(/[?&]k=([^&]+)/g)) {
        try { push(decodeURIComponent(m[1])); } catch { push(m[1]); }
    }
    for (const m of iframeSrc.matchAll(/sitekey=([^&"']+)/gi)) {
        try { push(decodeURIComponent(m[1])); } catch { push(m[1]); }
    }
    for (const m of html.matchAll(/sitekey['":\s]+['"]([0-9A-Za-z_-]{20,})['"]/gi)) push(m[1]);
    for (const m of html.matchAll(/['"]sitekey['"]\s*:\s*['"]([^'"]+)['"]/gi)) push(m[1]);
    for (const m of html.matchAll(/grecaptcha\.(?:enterprise\.)?(?:render|execute)\([^,]+,\s*\{[^}]*['"]?sitekey['"]?\s*:\s*['"]([^'"]+)['"]/gi)) {
        push(m[1]);
    }

    // ___grecaptcha_cfg clients
    try {
        const clients = window.___grecaptcha_cfg?.clients;
        if (clients) {
            const walk = (obj, depth = 0) => {
                if (!obj || depth > 6) return;
                if (typeof obj === 'string' && obj.length >= 20 && /^[0-9A-Za-z_-]+$/.test(obj)) {
                    if (obj.startsWith('6L') || obj.length > 30) push(obj);
                }
                if (typeof obj === 'object') {
                    for (const k of Object.keys(obj)) {
                        if (/sitekey|siteKey/i.test(k) && typeof obj[k] === 'string') push(obj[k]);
                        else walk(obj[k], depth + 1);
                    }
                }
            };
            walk(clients);
        }
    } catch (_) { /* ignore */ }

    let vendor = '';
    let enterprise = /enterprise|grecaptcha\.enterprise/i.test(html + iframeSrc);
    let invisible = /size=invisible|data-size=["']invisible["']|grecaptcha\.execute/i.test(html + iframeSrc);
    let v3 = /grecaptcha\.(?:enterprise\.)?execute|recaptcha\/enterprise\.js|render=explicit.*v3|api\.js\?render=/i.test(html + iframeSrc);
    let action = '';

    const turnstileEl = document.querySelector('.cf-turnstile, [class*="cf-turnstile"]');
    if (turnstileEl) {
        action = String(turnstileEl.getAttribute('data-action') || '').trim();
        vendor = 'turnstile';
    }

    let arkosePublicKey = '';
    const arkoseEl = document.querySelector('[data-pkey], [data-public-key], iframe[src*="arkoselabs"], iframe[src*="funcaptcha"]');
    if (arkoseEl) {
        arkosePublicKey = String(
            arkoseEl.getAttribute('data-pkey')
            || arkoseEl.getAttribute('data-public-key')
            || ''
        ).trim();
        if (!arkosePublicKey) {
            const src = arkoseEl.src || '';
            const pm = src.match(/[?&](?:pk|public_key)=([^&]+)/i);
            if (pm) arkosePublicKey = decodeURIComponent(pm[1]);
        }
        if (arkosePublicKey) push(arkosePublicKey);
        vendor = vendor || 'arkose';
    }
    if (/arkoselabs|funcaptcha/i.test(html + iframeSrc)) vendor = vendor || 'arkose';

    let geetestCaptchaId = '';
    let geetestGt = '';
    let geetestChallenge = '';
    const gtId = html.match(/captcha_id['":\s]+['"]([0-9a-f-]{32,})['"]/i);
    if (gtId) geetestCaptchaId = gtId[1];
    const gtM = html.match(/\bgt['":\s]+['"]([0-9a-f]{32})['"]/i);
    if (gtM) geetestGt = gtM[1];
    const chM = html.match(/challenge['":\s]+['"]([0-9a-f]{32,})['"]/i);
    if (chM) geetestChallenge = chM[1];
    if (geetestCaptchaId || geetestGt || /geetest/i.test(html)) {
        vendor = vendor || 'geetest';
        push(geetestCaptchaId || geetestGt);
    }

    let awsKey = '';
    let awsIv = '';
    let awsContext = '';
    const awsKeyM = html.match(/"key"\s*:\s*"([^"]+)"/);
    if (/awswaf|amazon.?waf|captcha\.awswaf/i.test(html + iframeSrc)) {
        vendor = vendor || 'aws_waf';
        const k2 = html.match(/awsKey['":\s]+['"]([^'"]+)['"]/i) || awsKeyM;
        if (k2) awsKey = k2[1];
    }

    if (/hcaptcha/i.test(iframeSrc) || document.querySelector('.h-captcha, [class*="h-captcha"]')) {
        vendor = vendor || 'hcaptcha';
    } else if (/turnstile|challenges\.cloudflare\.com\/turnstile/i.test(iframeSrc)) {
        vendor = vendor || 'turnstile';
    } else if (/recaptcha|google\.com\/recaptcha/i.test(iframeSrc)
        || document.querySelector('.g-recaptcha, #g-recaptcha')
        || sitekeys.some((k) => k.startsWith('6L'))) {
        vendor = vendor || (v3 ? 'recaptcha_v3' : 'recaptcha');
    }

    // pageAction from grecaptcha.execute('key', {action: '...'})
    const actM = html.match(/grecaptcha\.(?:enterprise\.)?execute\([^)]*action\s*:\s*['"]([^'"]+)['"]/i)
        || html.match(/['"]action['"]\s*:\s*['"]([a-zA-Z0-9_/.-]+)['"]/);
    if (actM && !action) action = actM[1];

    const sitekey = sitekeys[0] || '';
    return {
        pageUrl,
        userAgent,
        sitekey,
        sitekeys,
        vendor: vendor || (sitekey ? 'recaptcha' : ''),
        enterprise,
        invisible,
        v3,
        action,
        arkosePublicKey,
        geetestCaptchaId,
        geetestGt,
        geetestChallenge,
        awsKey,
        awsIv,
        awsContext
    };
}

/**
 * Page MAIN-world: inject token + fire callbacks aggressively.
 */
export function injectCaptchaTokenInPage(vend, tok) {
    if (Array.isArray(vend)) {
        tok = vend[1];
        vend = vend[0];
    } else if (vend && typeof vend === 'object' && (vend.tok != null || vend.token != null)) {
        tok = vend.tok || vend.token;
        vend = vend.vend || vend.vendor || 'recaptcha';
    }
    const setVal = (el, val) => {
        if (!el) return;
        const proto = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement?.prototype || {}, 'value')
            || Object.getOwnPropertyDescriptor(window.HTMLInputElement?.prototype || {}, 'value');
        if (proto?.set) {
            try { proto.set.call(el, val); } catch { el.value = val; }
        } else {
            el.value = val;
        }
        try { el.innerHTML = val; } catch (_) { /* ignore */ }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const ensureField = (name, tag = 'textarea') => {
        let el = document.querySelector(`[name="${name}"]`);
        if (el) return el;
        el = document.createElement(tag);
        el.name = name;
        if (tag === 'textarea') el.id = name;
        else el.type = 'hidden';
        el.style.cssText = 'display:none !important';
        (document.querySelector('form') || document.body).appendChild(el);
        return el;
    };

    const areas = [
        ...document.querySelectorAll(
            'textarea[name="g-recaptcha-response"], '
            + 'textarea[id*="g-recaptcha-response"], '
            + '#g-recaptcha-response'
        )
    ];
    if (!areas.length && /recaptcha|hcaptcha|^$/i.test(String(vend))) {
        areas.push(ensureField('g-recaptcha-response'));
    }
    for (const a of areas) setVal(a, tok);

    if (/hcaptcha/i.test(vend)) {
        const hAreas = [
            ...document.querySelectorAll(
                'textarea[name="h-captcha-response"], [name="h-captcha-response"], [data-hcaptcha-response]'
            )
        ];
        if (!hAreas.length) hAreas.push(ensureField('h-captcha-response'));
        for (const a of hAreas) {
            setVal(a, tok);
            try { a.setAttribute('data-hcaptcha-response', tok); } catch (_) { /* ignore */ }
        }
    }

    if (/turnstile|aws_waf/i.test(vend)) {
        const tAreas = [
            ...document.querySelectorAll(
                'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"], [name="cf-turnstile-response"]'
            )
        ];
        if (!tAreas.length) tAreas.push(ensureField('cf-turnstile-response', 'input'));
        for (const a of tAreas) setVal(a, tok);
    }

    if (/arkose|funcaptcha/i.test(vend)) {
        const fc = ensureField('fc-token', 'input');
        setVal(fc, tok);
        document.querySelectorAll('[name="cf-turnstile-response"], input[name="verification-token"]').forEach((el) => setVal(el, tok));
    }

    if (/geetest/i.test(vend)) {
        try {
            const data = JSON.parse(tok);
            const form = document.querySelector('form') || document.body;
            for (const [k, v] of Object.entries(data)) {
                if (typeof v !== 'string' && typeof v !== 'number') continue;
                let el = document.querySelector(`[name="${k}"]`);
                if (!el) {
                    el = document.createElement('input');
                    el.type = 'hidden';
                    el.name = k;
                    form.appendChild(el);
                }
                setVal(el, String(v));
            }
        } catch (_) {
            const el = ensureField('geetest_validate', 'input');
            setVal(el, tok);
        }
    }

    const callName = (name) => {
        if (!name) return;
        try {
            const fn = window[name];
            if (typeof fn === 'function') fn(tok);
        } catch (_) { /* ignore */ }
        try {
            // eslint-disable-next-line no-new-func
            const fn = new Function('token', `return (${name})(token);`);
            fn(tok);
        } catch (_) { /* ignore */ }
    };

    document.querySelectorAll(
        '.g-recaptcha[data-callback], .h-captcha[data-callback], .cf-turnstile[data-callback], [data-sitekey][data-callback]'
    ).forEach((widget) => callName(widget.getAttribute('data-callback')));

    try {
        if (window.___grecaptcha_cfg?.clients) {
            const clients = window.___grecaptcha_cfg.clients;
            Object.keys(clients).forEach((id) => {
                const walk = (obj, depth = 0) => {
                    if (!obj || depth > 6) return;
                    if (typeof obj.callback === 'function') {
                        try { obj.callback(tok); } catch (_) { /* ignore */ }
                    }
                    if (typeof obj === 'object') {
                        Object.keys(obj).forEach((k) => walk(obj[k], depth + 1));
                    }
                };
                walk(clients[id]);
            });
        }
    } catch (_) { /* ignore */ }

    try {
        if (window.grecaptcha) {
            window.grecaptcha.getResponse = function () { return tok; };
            if (window.grecaptcha.enterprise) {
                window.grecaptcha.enterprise.getResponse = function () { return tok; };
            }
        }
    } catch (_) { /* ignore */ }
    try {
        if (window.hcaptcha) window.hcaptcha.getResponse = function () { return tok; };
    } catch (_) { /* ignore */ }
    try {
        if (window.turnstile) window.turnstile.getResponse = function () { return tok; };
    } catch (_) { /* ignore */ }

    return {
        ok: true,
        filledAreas: areas.length,
        hasResponse: !!document.querySelector(
            'textarea[name="g-recaptcha-response"], [name="h-captcha-response"], [name="cf-turnstile-response"], [name="fc-token"]'
        ),
        responseLen: String(
            document.querySelector(
                'textarea[name="g-recaptcha-response"], [name="h-captcha-response"], [name="cf-turnstile-response"], [name="fc-token"]'
            )?.value || ''
        ).length
    };
}

export async function extractCaptchaTarget(tabId) {
    try {
        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: extractCaptchaTargetInPage
        });
        return result || null;
    } catch (err) {
        return { error: err?.message || String(err) };
    }
}

export async function injectCaptchaToken(tabId, { vendor, token } = {}) {
    const t = String(token || '').trim();
    if (!t) return { ok: false, error: 'empty_token' };
    try {
        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            args: [String(vendor || 'recaptcha'), t],
            func: injectCaptchaTokenInPage
        });
        // Second pass shortly after — some widgets rewrite the DOM
        await sleep(400);
        await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            args: [String(vendor || 'recaptcha'), t],
            func: injectCaptchaTokenInPage
        }).catch(() => {});
        return result || { ok: true };
    } catch (err) {
        return { ok: false, error: err?.message || String(err) };
    }
}

/**
 * Full high-success path: extract → multi-strategy API → inject.
 */
export async function solveCaptchaOnTab(tabId, prefs = {}, wall = {}) {
    const hasCap = !!String(prefs.capsolverApiKey || '').trim();
    const hasTwo = !!String(prefs.twocaptchaApiKey || '').trim();
    if (!hasCap && !hasTwo) {
        return { ok: false, skipped: true, error: 'no_solver_api_key' };
    }

    let target = await extractCaptchaTarget(tabId);
    // Late-loading widgets: brief wait + re-extract
    if (!target?.sitekey && !(target?.sitekeys || []).length && !target?.arkosePublicKey) {
        await sleep(2500);
        target = await extractCaptchaTarget(tabId);
    }
    if (!target?.sitekey && !(target?.sitekeys || []).length
        && !target?.arkosePublicKey && !target?.geetestCaptchaId && !target?.geetestGt) {
        return { ok: false, error: 'sitekey_not_found', target };
    }

    let vendor = String(wall?.vendor || target.vendor || 'recaptcha').toLowerCase();
    if (!isSolvableVendor(vendor)) {
        if (isSolvableVendor(target.vendor)) vendor = String(target.vendor).toLowerCase();
        else return { ok: false, skipped: true, error: 'vendor_not_solvable', vendor, target };
    }

    const attempts = buildSolveAttempts(target, wall);
    if (!attempts.length) {
        return { ok: false, error: 'no_solve_attempts', target, vendor };
    }

    const totalBudget = Math.min(240000, Number(prefs.captchaSolverTimeoutMs) || 240000);
    const perAttempt = Math.max(45000, Math.floor(totalBudget / Math.min(attempts.length, 4)));
    const started = Date.now();
    const attemptLog = [];
    let solved = null;

    for (const attempt of attempts) {
        if (Date.now() - started > totalBudget) break;
        const slice = Math.min(perAttempt, Math.max(20000, totalBudget - (Date.now() - started)));
        const common = { ...attempt, timeoutMs: slice };

        if (hasCap) {
            solved = await solveWithCapSolver({ ...common, apiKey: prefs.capsolverApiKey });
            attemptLog.push({
                provider: 'capsolver',
                label: attempt.label,
                ok: !!solved?.ok,
                error: solved?.error || null,
                taskType: solved?.taskType || attempt.taskType
            });
            if (solved?.ok && solved.token) break;
        }
        if ((!solved?.ok || !solved.token) && hasTwo) {
            solved = await solveWith2Captcha({ ...common, apiKey: prefs.twocaptchaApiKey });
            attemptLog.push({
                provider: '2captcha',
                label: attempt.label,
                ok: !!solved?.ok,
                error: solved?.error || null
            });
            if (solved?.ok && solved.token) break;
        }
    }

    if (!solved?.ok || !solved.token) {
        return {
            ok: false,
            error: solved?.error || 'all_strategies_failed',
            target,
            vendor,
            attempts: attemptLog
        };
    }

    const injectVendor = /recaptcha/i.test(solved.vendor) ? 'recaptcha' : solved.vendor;
    const injected = await injectCaptchaToken(tabId, { vendor: injectVendor, token: solved.token });
    if (!injected?.ok) {
        return {
            ok: false,
            error: injected?.error || 'inject_failed',
            tokenOk: true,
            provider: solved.provider,
            attempts: attemptLog
        };
    }

    return {
        ok: true,
        provider: solved.provider,
        vendor: solved.vendor,
        sitekey: attempts[0]?.websiteKey || target.sitekey,
        taskType: solved.taskType || null,
        injected: true,
        responseLen: injected.responseLen || 0,
        attempts: attemptLog
    };
}
