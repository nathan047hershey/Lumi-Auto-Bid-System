// =============================================================================
// services/scraper/providers.js — pluggable scraper backends for job links
// =============================================================================
//
// The job_links scraper has two interchangeable backends:
//
//   pythonService  — a Playwright (Python) microservice that the Node
//                    cron talks to over HTTP. Preferred when it's
//                    reachable, because Playwright's stealth is
//                    considerably more reliable against LinkedIn's
//                    anti-bot wall than puppeteer-core without
//                    anti-detection add-ons.
//
//                    The Python service runs in its own process and
//                    is responsible for its own rate limiting (2
//                    fetches per second), browser lifecycle, etc. We
//                    treat it as an external HTTP resource.
//
//   nodeBuiltin    — a fallback that runs inside the Node process
//                    using puppeteer-core (already in the
//                    project's deps) and the project's existing
//                    Cheerio + JSON-LD parser. Used when no Python
//                    service is configured / reachable. Same rate
//                    limit (2/s) is applied at the Node layer so
//                    we don't burn through LinkedIn's quota while
//                    the Python service is down.
//
// The provider is selected at module load time via the
// `JOB_LINKS_SCRAPER_PROVIDER` env var:
//
//   unset / "auto"     prefer pythonService if reachable, else nodeBuiltin
//   "python"           require pythonService; error if unreachable
//   "node"             always use nodeBuiltin (skip Python probe)
//
// Public API (consumed by services/jobLinkScraper.js):
//
//   provider.name                                — 'pythonService' | 'nodeBuiltin'
//   provider.fetchJobLinkedIn(url)               — async; returns
//                                                   { title, company, description,
//                                                     location? } | { error }
// =============================================================================

const path = require('path');
const axios = require('axios');
const {
    leverScrapeUrl,
    isLeverUrl
} = require('./leverUrl');

// URL of the Python scraper service. The Python module
// (`services/scraper/python_service.py`) defaults to listening on
// http://127.0.0.1:8765, but this can be overridden.
const PYTHON_SERVICE_URL = process.env.JOB_LINKS_SCRAPER_URL
    || 'http://127.0.0.1:8765';

// Timeout for the probe at boot — keep this short so a missing
// Python service doesn't delay server startup noticeably.
const PYTHON_PROBE_TIMEOUT_MS = 750;

// Timeout for an individual scrape call. Playwright + a headless
// Chromium typically returns in 4–10 seconds; we tolerate up to 30
// so a single slow LinkedIn response doesn't kill the worker.
const PYTHON_SCRAPE_TIMEOUT_MS = 30 * 1000;

// -----------------------------------------------------------------------------
// Python service provider
// -----------------------------------------------------------------------------

/**
 * Health-check the Python service. Returns true if the service is
 * reachable AND responds to /health, false otherwise.
 */
async function probePythonService() {
    try {
        const r = await axios.get(`${PYTHON_SERVICE_URL}/health`, {
            timeout: PYTHON_PROBE_TIMEOUT_MS,
            validateStatus: () => true
        });
        return r.status === 200;
    } catch (_) {
        return false;
    }
}

/**
 * Call the Python service to scrape a single LinkedIn job URL. The
 * Python side owns Playwright + rate limiting; we just translate
 * HTTP errors back into the same shape our builtin scraper returns.
 *
 * The Python service surfaces LinkedIn's sign-in wall with HTTP
 * 200 + `auth_wall: true` in the body (instead of an error code)
 * so we can show a useful message in the row's `fetch_error`
 * column rather than just "Not Found".
 */
async function pythonFetch(url) {
    try {
        // Lever /apply is form-only; send the posting URL so HTML
        // fallback (if API misses) still finds `.posting-description`.
        const scrapeTarget = isLeverUrl(url) ? (leverScrapeUrl(url) || url) : url;
        const r = await axios.post(
            `${PYTHON_SERVICE_URL}/scrape`,
            { url: scrapeTarget },
            { timeout: PYTHON_SCRAPE_TIMEOUT_MS, validateStatus: () => true }
        );
        if (r.status !== 200) {
            return { error: `Python scraper ${r.status}: ${JSON.stringify(r.data)}` };
        }
        const body = r.data || {};
        if (body.auth_wall) {
            return {
                error: body.message || 'linkedin-auth-wall: set LINKEDIN_LI_AT to a valid li_at cookie'
            };
        }
        // If the Python service signalled a structured error (e.g.
        // `not-a-workday-job-url` when a Workday URL was missing
        // its /job/<loc>/<title> shape), forward it verbatim so
        // the Node cron records an accurate fetch_error.
        if (body.error) {
            return { error: body.error };
        }
        // The Python service returns JSON-LD-shaped fields, parsed
        // into the same shape the cron expects.
        return {
            title: body.position_title || null,
            company: body.company_name || null,
            location: body.location || null,
            description: body.description || null
        };
    } catch (err) {
        return { error: `Python scraper unreachable: ${err.message}` };
    }
}

const pythonService = {
    name: 'pythonService',
    fetchJobLinkedIn: pythonFetch,
    probe: probePythonService
};

// -----------------------------------------------------------------------------
// Built-in Node fallback (puppeteer-core + cheerio)
// -----------------------------------------------------------------------------
//
// This is the previous behaviour: spin up Chromium via puppeteer-core,
// fall back to plain HTTP when no Chromium binary is present, and
// parse the resulting HTML for the structured JSON-LD block /
// fallback DOM selectors.

const cheerio = require('cheerio');
const fs = require('fs');

// How long to give a single page fetch before we give up. Mirrors
// what puppeteer-core's `goto` accepts.
const NODE_GOTO_TIMEOUT_MS = 30 * 1000;

// Cached references — puppeteer-core does some non-trivial work on
// first require() and the chromium-path probe touches the FS, so we
// only want to do each once.
let puppeteerCore = null;
let puppeteerTried = false;
let chromiumPath = null;
let chromiumProbed = false;

function loadPuppeteer() {
    if (puppeteerTried) return puppeteerCore;
    puppeteerTried = true;
    try {
        puppeteerCore = require('puppeteer-core');
    } catch (err) {
        puppeteerCore = null;
    }
    return puppeteerCore;
}

function probeChromium() {
    if (chromiumProbed) return chromiumPath;
    chromiumProbed = true;
    const candidates = [
        process.env.CHROMIUM_PATH,
        process.env.PUPPETEER_EXECUTABLE_PATH,
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/snap/bin/chromium'
    ].filter(Boolean);
    for (const p of candidates) {
        try { if (fs.existsSync(p)) { chromiumPath = p; return p; } } catch (_) { /* ignore */ }
    }
    return null;
}

/**
 * Launch a headless Chromium via puppeteer-core. Returns null when no
 * Chromium binary is present on this host — the caller should fall
 * back to plain HTTP.
 */
async function fetchWithBrowser(url, chromiumBin) {
    const puppeteer = loadPuppeteer();
    if (!puppeteer || !chromiumBin) return null;
    const browser = await puppeteer.launch({
        executablePath: chromiumBin,
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled'
        ]
    });
    try {
        const page = await browser.newPage();
        await page.setUserAgent(
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
            + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        );
        await page.setViewport({ width: 1280, height: 800 });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NODE_GOTO_TIMEOUT_MS });
        await sleep(1500);
        return await page.content();
    } finally {
        try { await browser.close(); } catch (_) { /* ignore */ }
    }
}

/**
 * Plain-HTTP fetch fallback. Cheaper than spinning up Chromium and
 * often enough to grab JSON-LD + meta tags.
 */
async function fetchWithHttp(url) {
    const res = await axios.get(url, {
        timeout: NODE_GOTO_TIMEOUT_MS,
        maxRedirects: 5,
        headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
                + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9'
        },
        validateStatus: () => true
    });
    if (res.status >= 400) {
        throw new Error(`HTTP ${res.status}`);
    }
    return res.data;
}

/**
 * Parse job-page HTML into structured fields. JSON-LD JobPosting
 * first (works for Workday, SmartRecruiters, Workable, etc.), then
 * LinkedIn DOM / OG meta fallbacks.
 */
function parseJobHtml(html) {
    if (!html || typeof html !== 'string') return {};
    const $ = cheerio.load(html);

    // JSON-LD first — it's the cleanest source
    let ld = null;
    const tryParseLd = (text) => {
        if (!text) return;
        try {
            const data = JSON.parse(text);
            const candidates = Array.isArray(data) ? data : [data];
            if (data && Array.isArray(data['@graph'])) {
                candidates.push(...data['@graph']);
            }
            for (const node of candidates) {
                if (!node || typeof node !== 'object') continue;
                const type = node['@type'];
                const isJob = type === 'JobPosting'
                    || (Array.isArray(type) && type.includes('JobPosting'));
                if (isJob) {
                    ld = node;
                    return true;
                }
            }
        } catch (_) { /* malformed JSON-LD */ }
        return false;
    };

    $('script[type="application/ld+json"]').each((_, el) => {
        const text = $(el).html() || $(el).contents().text() || $(el).text() || '';
        if (tryParseLd(text)) return false;
    });
    // Regex fallback — some ATS shells confuse cheerio's script walker.
    if (!ld) {
        const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
        let m;
        while ((m = re.exec(html)) != null) {
            if (tryParseLd(m[1])) break;
        }
    }

    if (ld) {
        const org = ld.hiringOrganization || {};
        let loc = null;
        if (ld.jobLocation) {
            const jl = Array.isArray(ld.jobLocation) ? ld.jobLocation[0] : ld.jobLocation;
            loc = jl && jl.address ? jl.address : null;
        }
        const locParts = loc
            ? [loc.addressLocality, loc.addressRegion, loc.addressCountry].filter(Boolean)
            : [];
        const descHtml = ld.description || '';
        return {
            title: ld.title || ld.name || null,
            company: org.name || null,
            location: locParts.join(', ') || null,
            description: descHtml ? cheerio.load(descHtml).text().trim() : null
        };
    }

    // Fallback — meta tags + DOM scraping (LinkedIn + generic)
    const meta = (selector, attr = 'content') => $(selector).attr(attr);
    const domTitle =
        $('.top-card-layout__title').first().text().trim()
        || $('.job-details-jobs-unified-top-card__job-title').first().text().trim()
        || $('h1').first().text().trim()
        || null;
    const domCompany =
        $('.top-card-layout__company-name').first().text().trim()
        || $('.job-details-jobs-unified-top-card__company-name').first().text().trim()
        || null;
    const domDescription =
        $('.description__text').first().text().trim()
        || $('.job-details-jobs-unified-top-card__job-description').first().text().trim()
        || $('[class*="job-description"]').first().text().trim()
        || null;

    return {
        title: domTitle || meta('meta[property="og:title"]') || null,
        company: domCompany || null,
        location: null,
        description: domDescription || meta('meta[property="og:description"]') || null
    };
}

/** @deprecated alias — keep for any external callers */
const parseLinkedInHtml = parseJobHtml;

/**
 * Convert HTML (or entity-escaped HTML) to plain text.
 *
 * Greenhouse boards API returns `content` with tags entity-encoded
 * (`&lt;div&gt;...`). Cheerio's `.text()` on that string only
 * *decodes* the entities, leaving visible `<div>` markup in the
 * result. Decode once when we detect that pattern, then strip tags.
 */
function stripHtml(html) {
    if (!html) return '';
    let s = String(html);
    if (/&lt;\/?[a-z][\s\S]*&gt;/i.test(s)) {
        s = s
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"')
            .replace(/&#0*39;|&apos;/gi, "'")
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&');
    }
    return cheerio.load(s).text().replace(/\s+/g, ' ').trim();
}

const {
    parseGreenhouseBoardAndJob,
    greenhouseScrapeUrl,
    isGreenhouseUrl
} = require('./greenhouseUrl');

/**
 * Structured public-API fetchers for ATS hosts. Used when the Python
 * service is down so Greenhouse / Lever / Ashby still scrape.
 */
async function fetchGreenhouseApi(url) {
    const parsed = parseGreenhouseBoardAndJob(url);
    if (!parsed) return null;
    const board = encodeURIComponent(parsed.board);
    const jobId = parsed.jobId;
    const api = `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${jobId}?questions=false`;
    const res = await axios.get(api, { timeout: NODE_GOTO_TIMEOUT_MS, validateStatus: () => true });
    if (res.status === 404 || (res.data && res.data.status === 404)) {
        return { error: `greenhouse-job-not-found: board=${parsed.board} job=${jobId}` };
    }
    if (res.status !== 200 || !res.data || !res.data.title) {
        return { error: `greenhouse-api-${res.status}` };
    }
    const j = res.data;
    const description = stripHtml(j.content || '') || null;
    if (!description || description.length < 40) {
        return { error: 'greenhouse-empty-description' };
    }
    return {
        title: (j.title || '').trim() || null,
        company: (j.company_name || parsed.board.replace(/-/g, ' ')).trim() || null,
        location: j.location && j.location.name ? j.location.name : null,
        description,
        greenhouse: { board: parsed.board, jobId: parsed.jobId }
    };
}

async function fetchLeverApi(url) {
    const m = url.match(/lever\.co\/([^/]+)/i);
    if (!m) return null;
    const company = m[1];
    const idMatch = url.match(/\/([0-9a-f-]{36,})/i);
    if (!idMatch) return { error: 'lever-missing-posting-id' };
    const postingId = idMatch[1];
    const api = `https://api.lever.co/v0/postings/${encodeURIComponent(company)}?mode=json`;
    const res = await axios.get(api, { timeout: NODE_GOTO_TIMEOUT_MS, validateStatus: () => true });
    if (res.status === 404) return { error: `lever-company-not-found: ${company}` };
    if (res.status !== 200 || !Array.isArray(res.data)) {
        return { error: `lever-api-${res.status}` };
    }
    const pick = res.data.find((p) => p && p.id === postingId);
    if (!pick) return { error: `lever-posting-not-found: ${postingId}` };
    const listHtml = (pick.lists || [])
        .map((blk) => (blk && blk.content) || '')
        .join('\n\n')
        .trim();
    const description = stripHtml(listHtml)
        || stripHtml(pick.content || '')
        || stripHtml(pick.description || '')
        || stripHtml(pick.descriptionPlain || '')
        || null;
    if (!description || description.length < 40) {
        return { error: 'lever-empty-description' };
    }
    return {
        title: (pick.title || pick.text || '').trim() || null,
        company: company.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        location: (pick.categories && pick.categories.location) || null,
        description
    };
}

async function fetchAshbyApi(url) {
    const m = url.match(/jobs\.ashbyhq\.com\/([^/]+)\/([0-9a-f-]{8,})/i);
    if (!m) return null;
    const board = encodeURIComponent(m[1]);
    const postingId = m[2];
    const api = `https://api.ashbyhq.com/posting-api/job-board/${board}?includeCompensation=true`;
    const res = await axios.get(api, { timeout: NODE_GOTO_TIMEOUT_MS, validateStatus: () => true });
    if (res.status !== 200 || !res.data || !Array.isArray(res.data.jobs)) {
        return { error: `ashby-api-${res.status}` };
    }
    const pick = res.data.jobs.find((j) => j && (j.id === postingId || j.jobId === postingId));
    if (!pick) return { error: `ashby-posting-not-found: ${postingId}` };
    const description = stripHtml(pick.descriptionHtml || pick.descriptionPlain || '') || null;
    if (!description || description.length < 40) {
        return { error: 'ashby-empty-description' };
    }
    return {
        title: (pick.title || '').trim() || null,
        // Prefer board slug (bankjoy) — pick.department is often "Engineering", not the company.
        company: String(m[1] || '')
            .replace(/-/g, ' ')
            .replace(/\b\w/g, (c) => c.toUpperCase())
            || (pick.department || null),
        location: (pick.location || (pick.address && pick.address.postalAddress)) || null,
        description
    };
}

/**
 * Workday public CXS JSON API.
 * URL: https://{company}.wdN.myworkdayjobs.com/{site}/job/{loc}/{slug}
 * API: https://{company}.wdN.myworkdayjobs.com/wday/cxs/{company}/{site}/job/{slug}
 */
function parseWorkdayJobUrl(url) {
    const m = String(url || '').match(
        /^https?:\/\/([^.]+)\.(wd\d+)\.myworkdayjobs\.com\/([^/?#]+)\/job\/([^/?#]+)\/([^/?#]+)/i
    );
    if (!m) return null;
    return {
        company: m[1],
        wd: m[2],
        site: m[3],
        locationPath: m[4],
        slug: decodeURIComponent(m[5]).replace(/\/+$/, '')
    };
}

async function fetchWorkdayCxs(url) {
    const p = parseWorkdayJobUrl(url);
    if (!p) return null;
    const api = `https://${p.company}.${p.wd}.myworkdayjobs.com/wday/cxs/${encodeURIComponent(p.company)}/${encodeURIComponent(p.site)}/job/${encodeURIComponent(p.slug)}`;
    const res = await axios.get(api, {
        timeout: NODE_GOTO_TIMEOUT_MS,
        validateStatus: () => true,
        headers: {
            Accept: 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                + '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        }
    });
    if (res.status === 404) {
        return { error: `workday-job-not-found: ${p.slug}` };
    }
    if (res.status !== 200 || !res.data) {
        return { error: `workday-cxs-${res.status}` };
    }
    const info = res.data.jobPostingInfo || res.data;
    const description = stripHtml(info.jobDescription || info.description || '') || null;
    if (!description || description.length < 40) {
        return { error: 'workday-empty-description' };
    }
    const companyName =
        (res.data.hiringOrganization && res.data.hiringOrganization.name)
        || p.company.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    let location = info.location || info.jobPostingLocation || null;
    if (Array.isArray(location)) location = location.filter(Boolean).join(', ');
    else if (location && typeof location === 'object') {
        location = location.descriptor || location.name || JSON.stringify(location);
    }
    return {
        title: (info.title || info.jobTitle || '').trim() || null,
        company: String(companyName || '').trim() || null,
        location: location ? String(location).trim() : null,
        description,
        workday: { company: p.company, site: p.site, slug: p.slug }
    };
}

async function fetchStructuredAts(url) {
    try {
        if (isGreenhouseUrl(url) || /greenhouse\.io/i.test(url)) {
            // Normalize embed → classic /jobs/<id> so the boards API always matches.
            return await fetchGreenhouseApi(greenhouseScrapeUrl(url) || url);
        }
        if (isLeverUrl(url) || /lever\.co/i.test(url)) {
            // Apply pages omit the JD; scrape the posting URL instead.
            return await fetchLeverApi(leverScrapeUrl(url) || url);
        }
        if (/ashbyhq\.com/i.test(url)) return await fetchAshbyApi(url);
        if (/myworkdayjobs\.com/i.test(url)) return await fetchWorkdayCxs(url);
    } catch (err) {
        console.warn('[scraper] structured ATS fetch failed:', err.message);
        return { error: `structured-ats-error: ${err.message}` };
    }
    return null;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isThinScrape(parsed) {
    const desc = (parsed && parsed.description && String(parsed.description).trim()) || '';
    return desc.length < 80;
}

async function nodeFetch(url) {
    try {
        // Lever /apply is the form only — HTML scrape needs the posting page.
        const pageUrl = isLeverUrl(url) ? (leverScrapeUrl(url) || url) : url;

        // Prefer public ATS JSON APIs when Python is down — they are
        // faster and more reliable than HTML parsing for these hosts.
        const structured = await fetchStructuredAts(pageUrl);
        if (structured && structured.error) {
            // Definite miss (404 / wrong id) — do NOT fall through to
            // the board index HTML, which would store "All Jobs".
            // Soft misses (empty) may still try HTML below.
            if (/not-found|404/i.test(String(structured.error))) {
                return structured;
            }
        }
        if (structured && !structured.error && !isThinScrape(structured)) {
            return structured;
        }

        const chromiumBin = probeChromium();
        let html = null;
        let browserParsed = null;
        try {
            html = await fetchWithBrowser(pageUrl, chromiumBin);
            if (html) {
                browserParsed = parseJobHtml(html);
                if (!isThinScrape(browserParsed)) {
                    return {
                        title: browserParsed.title || null,
                        company: browserParsed.company || null,
                        location: browserParsed.location || null,
                        description: browserParsed.description || null
                    };
                }
            }
        } catch (browserErr) {
            // Browser path failed; fall through to HTTP
        }

        // HTTP fallback (SPA shells from headless often lack JSON-LD).
        try {
            html = await fetchWithHttp(pageUrl);
        } catch (_) {
            html = null;
        }
        if (html) {
            const parsed = parseJobHtml(html);
            if (!isThinScrape(parsed)) {
                return {
                    title: parsed.title || null,
                    company: parsed.company || null,
                    location: parsed.location || null,
                    description: parsed.description || null
                };
            }
        }

        // Last chance: structured again (e.g. Workday CXS) if first
        // attempt was a soft empty miss.
        if (structured && !structured.error && structured.description) {
            return structured;
        }
        if (structured && structured.error && !/not-found|404/i.test(String(structured.error))) {
            return structured;
        }
        return { error: 'scrape-empty: no usable job description extracted from page' };
    } catch (err) {
        return { error: (err && err.message) || String(err) };
    }
}

const nodeBuiltin = {
    name: 'nodeBuiltin',
    fetchJobLinkedIn: nodeFetch,
    hasBrowser: () => !!probeChromium(),
    probe: async () => true
};

// -----------------------------------------------------------------------------
// Selection
// -----------------------------------------------------------------------------

/**
 * Pick the active provider at module load time. Tries the Python
 * service first when `auto` is configured; falls back to the Node
 * builtin when the probe fails (or when Python is explicitly
 * disabled).
 */
async function selectProvider() {
    const want = (process.env.JOB_LINKS_SCRAPER_PROVIDER || 'auto').toLowerCase();
    if (want === 'node') {
        console.log('[scraper] provider=nodeBuiltin (forced via env)');
        return nodeBuiltin;
    }
    const ok = await pythonService.probe();
    if (ok) {
        console.log(`[scraper] provider=pythonService (reachable at ${PYTHON_SERVICE_URL})`);
        return pythonService;
    }
    if (want === 'python') {
        console.warn(`[scraper] provider=pythonService required but unreachable at ${PYTHON_SERVICE_URL}`);
        // Even when forced, fall back to the builtin so scraping
        // keeps working. The next poll will try again.
        return nodeBuiltin;
    }
    console.log('[scraper] provider=nodeBuiltin (Python service unreachable)');
    return nodeBuiltin;
}

module.exports = {
    selectProvider,
    pythonService,
    nodeBuiltin,
    PYTHON_SERVICE_URL,
    parseGreenhouseBoardAndJob,
    greenhouseScrapeUrl,
    isGreenhouseUrl,
    leverScrapeUrl,
    isLeverUrl
};
