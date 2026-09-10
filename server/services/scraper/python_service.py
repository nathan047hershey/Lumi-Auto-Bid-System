#!/usr/bin/env python3
# =============================================================================
# python_service.py — Public job-board scraper microservice
# =============================================================================
#
# This is the "Python side" of the job_links scraping pipeline. The Node
# cron (`services/jobLinkScraper.js`) sends POST /scrape requests here;
# the dispatcher picks the right fetch strategy for the URL host and
# returns the structured fields the Node side stores in `job_links`.
#
# Supported sources:
#
#   • LinkedIn   — playwright + (optional) `li_at` cookie. Auth-wall
#                  detected so the Node side records a useful
#                  fetch_error.
#   • Greenhouse  — public JSON API at
#                    boards-api.greenhouse.io/v1/boards/<board>/jobs/<id>.
#                    No auth, no Playwright needed.
#   • Lever       — public JSON API at
#                    api.lever.co/v0/postings/<company>.
#   • Ashby       — public JSON API at
#                    api.ashbyhq.com/posting-api/job-board/<board>.
#                    No auth, no Playwright needed.
#   • Gem         — jobs.gem.com/<board>/<extId>; SPA shell only.
#                    Uses GraphQL batch POST
#                    jobs.gem.com/api/public/graphql/batch (header
#                    batch: true), with REST board list fallback.
#   • iCIMS       — Playwright render of the public career site with
#                    `?in_iframe=1`. iCIMS hides the job DOM behind a
#                    client-side iFrame loader unless you ask for the
#                    iframe variant; the public JSON API is gated.
#                    Accepts `careers-<org>.icims.com` and
#                    `*.icims.com/jobs/...` URLs.
#   • JobVite     — `jv-job-detail-description` + meta + title.
#   • Workday     — `*.myworkdayjobs.com`. Workday serves a
#                    schema.org/JobPosting JSON-LD block that the
#                    generic renderer can pick up.
#   • SuccessFactors (SAP) — class `jobdescription` + meta; used by
#                            Gainwell, Adobe, and many enterprises.
#   • Paycom      — SPA with OG meta tags (title has the job ID).
#   • ApplyToJob  — `<company>.applytojob.com/apply/...`; OG tags
#                    carry title + keywords; falls back to Playwright
#                    for the description body.
#   • Rippling    — `ats.rippling.com/<company>/jobs/<uuid>`; OG tags
#                    carry title + description.
#   • Anything    — generic Playwright renderer; tries schema.org
#     else         JobPosting JSON-LD, then OG meta tags.
#
# Endpoint shapes (POST application/json):
#
#   POST /scrape
#     Body: { "url": "<any of the above>" }
#     200:
#       {
#         "position_title": "...",
#         "company_name":   "...",
#         "location":       "...",
#         "description":    "..."
#       }
#     200 (auth-wall):
#       { "auth_wall": true, "error": "linkedin-auth-wall", ... }
#     400: invalid URL / unsupported host
#     502: scrape failed (browser crash, 404 on a public API, etc.)
#
#   GET /health → 200 { "status": "ok", "auth": "...", "cookie_present": ... }
#
# Rate limiting
# -------------
# Requests are processed serially with a 500 ms gap (2 req/sec cap).
# A single Chromium is reused across requests; it's restarted on any
# unexpected crash.
# =============================================================================
#
# Run:
#   pip install flask playwright
#   playwright install chromium
#   python3 python_service.py              # default port 8765
#   PORT=9000 python3 python_service.py    # custom port
#
# The Node side reads the URL from the `JOB_LINKS_SCRAPER_URL` env
# var (defaulting to http://127.0.0.1:8765).
# =============================================================================

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from typing import Any

try:
    from flask import Flask, jsonify, request
except ImportError:  # pragma: no cover - environment without flask
    raise SystemExit(
        "Flask is required. Install it with `pip install flask` before running "
        "this service. See the header of this file for the full setup."
    )

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
except ImportError:  # pragma: no cover - environment without playwright
    raise SystemExit(
        "playwright is required. Install it with `pip install playwright` and "
        "then `playwright install chromium`."
    )


# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8765"))

# Hard cap on LinkedIn fetches: 500 ms = 2 req/sec. LinkedIn's
# documentation explicitly warns that sustained bursts from a single
# IP trigger 429 / auth-wall responses.
SCRAPE_INTERVAL_MS = int(os.environ.get("SCRAPE_INTERVAL_MS", "500"))

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

# LinkedIn session cookie. Without this, LinkedIn's anti-bot middleware
# serves the "Join LinkedIn" sign-in wall instead of the job page.
#
# Set LINKEDIN_LI_AT in the environment (e.g. in server/.env) to a
# real session cookie extracted from your browser. The service picks
# it up at startup; updates require a restart.
#
# To extract: in a real browser where you're logged into LinkedIn,
# open DevTools → Application → Cookies → www.linkedin.com → copy
# the value of `li_at`. The cookie usually has a ~1-year lifetime.
LI_AT_COOKIE = os.environ.get("LINKEDIN_LI_AT", "").strip()

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=LOG_LEVEL,
    format="[%(asctime)s] [python_service] %(levelname)s %(message)s",
)
log = logging.getLogger("python_service")


# -----------------------------------------------------------------------------
# Browser lifecycle
# -----------------------------------------------------------------------------

_playwright = None
_browser = None
_browser_lock = threading.Lock()


def _start_browser():
    """Launch the Playwright Chromium browser. Reused across scrape
    requests so we don't pay the ~1.5s launch cost per row."""
    global _playwright, _browser
    with _browser_lock:
        if _browser is not None:
            return _browser
        _playwright = sync_playwright().start()
        _browser = _playwright.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                # LinkedIn watches for the Chromium automation flag.
                # Disabling it removes the most obvious tell.
                "--disable-blink-features=AutomationControlled",
            ],
        )
        log.info("Chromium launched")
        return _browser


def _restart_browser():
    """Tear down the current browser (we hit a crash / auth wall) and
    spawn a fresh one on the next call. Keeps the service's uptime
    high even when LinkedIn slips a 999 / sign-in wall in front of
    us."""
    global _playwright, _browser
    with _browser_lock:
        try:
            if _browser is not None:
                _browser.close()
        except Exception:
            pass
        try:
            if _playwright is not None:
                _playwright.stop()
        except Exception:
            pass
        _playwright = None
        _browser = None


# -----------------------------------------------------------------------------
# Scraping — single URL
# -----------------------------------------------------------------------------

# A small bag of fallback selectors for each field. LinkedIn's
# standard A/B test rotates between layouts, so we walk the list and
# take whichever first matches.
TITLE_SELECTORS = (
    "h1.top-card-layout__title",
    "h1.topcard__title",
    "h2.topcard__title",
    "h1",
)
COMPANY_SELECTORS = (
    "a.topcard__org-name-link",
    ".top-card-layout__second-subline a",
    ".topcard__flavor--black-link",
    ".job-details-jobs-unified-top-card__company-name a",
    ".job-details-jobs-unified-top-card__company-name",
)
LOCATION_SELECTORS = (
    ".top-card-layout__location",
    ".topcard__flavor--secondary",
    ".job-details-jobs-unified-top-card__primary-description-container",
)
DESCRIPTION_SELECTORS = (
    "div.show-more-less-html__markup",
    "div.description__text.description__text--rich",
    ".show-more-less",
    ".job-details-jobs-unified-top-card__job-description",
)
SHOW_MORE_SELECTORS = (
    "button.show-more-less-button",
    "button[aria-expanded='false']",
)


def _first_text(page, selectors) -> str | None:
    """Return the trimmed text of the first selector that matches, or
    None if none do. Playwright's `query_selector` is cheap enough
    that we just try them in order."""
    for sel in selectors:
        try:
            el = page.query_selector(sel)
        except Exception:
            el = None
        if el:
            try:
                text = el.inner_text().strip()
            except Exception:
                text = ""
            if text:
                return text
    return None


def _click_show_more(page) -> None:
    """LinkedIn truncates the description behind a "Show more"
    button. Click it if it exists so we get the full text."""
    for sel in SHOW_MORE_SELECTORS:
        try:
            btn = page.query_selector(sel)
        except Exception:
            btn = None
        if btn is None:
            continue
        try:
            btn.click()
            time.sleep(1)
            return
        except Exception:
            # Show more button can be off-screen / blocked by overlays;
            # ignore the failure and fall back to whatever is visible.
            pass


def _is_auth_wall(text: str) -> bool:
    """Heuristic detection for LinkedIn's sign-in wall. When the
    scraper reaches this page we know the session cookie is missing
    or expired; reporting this back to the caller (instead of just
    "Not Found") makes the failure mode actionable in the UI."""
    if not text:
        return False
    lowered = text.lower()
    return (
        "join linkedin" in lowered
        or "sign in to linkedin" in lowered
        or "authwall" in lowered
    )


def fetch_linkedin_job_data(url: str) -> dict[str, str]:
    """Fetches job description, title, and company from a LinkedIn
    job URL. Returns a dict with `position_title`, `company_name`,
    `location`, `description` keys (all strings, possibly the literal
    "Not Found").

    When `LINKEDIN_LI_AT` is set, the session cookie is injected via
    `context.add_cookies(...)` so the request is treated as
    authenticated and the real job page renders. Without it, LinkedIn
    serves its sign-in wall and we surface an `auth_wall: True`
    flag in the response so the Node side can record a useful
    `fetch_error`."""
    log.info("scraping %s (auth=%s)", url, "cookie" if LI_AT_COOKIE else "anonymous")

    browser = _start_browser()
    context = browser.new_context(
        user_agent=USER_AGENT,
        viewport={"width": 1920, "height": 1080},
        # A few extra headers that real browsers send — reduces the
        # number of "this looks automated" signals LinkedIn checks
        # for. LinkedIn also checks navigator.webdriver but
        # --disable-blink-features=AutomationControlled handles that.
        extra_http_headers={
            "Accept": (
                "text/html,application/xhtml+xml,application/xml;q=0.9,"
                "image/avif,image/webp,*/*;q=0.8"
            ),
            "Accept-Language": "en-US,en;q=0.9",
            "sec-ch-ua": '"Chromium";v="126", "Not.A/Brand";v="24"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Linux"',
        },
    )

    # Inject the li_at cookie before any page loads. Doing this at
    # context-add time means the cookie is sent on the very first
    # request — important because LinkedIn sometimes redirects to
    # the auth wall before the page fully loads if the cookie isn't
    # present at the start.
    if LI_AT_COOKIE:
        context.add_cookies([
            {
                "name": "li_at",
                "value": LI_AT_COOKIE,
                "domain": ".linkedin.com",
                "path": "/",
                "httpOnly": True,
                "secure": True,
                "sameSite": "None",
            }
        ])

    page = context.new_page()
    try:
        page.goto(url, wait_until="networkidle", timeout=30_000)
        # LinkedIn hydrates the page after `networkidle`. A small
        # extra sleep lets late-rendered DOM nodes appear before we
        # scrape.
        time.sleep(2)

        title = _first_text(page, TITLE_SELECTORS) or "Not Found"
        company = _first_text(page, COMPANY_SELECTORS) or "Not Found"
        location = _first_text(page, LOCATION_SELECTORS) or ""

        _click_show_more(page)
        # Re-read the description after the click — the DOM has
        # expanded to the full text.
        description = _first_text(page, DESCRIPTION_SELECTORS) or "Not Found"

        # If LinkedIn redirected us to the auth wall, every field is
        # either "Not Found" or "Join LinkedIn". Setting `auth_wall`
        # lets the Node cron record a useful fetch_error instead of
        # silently writing meaningless data into the row.
        body_text = (title + " " + company + " " + description).lower()
        auth_wall = (
            _is_auth_wall(body_text)
            or _is_auth_wall(page.url or "")
        )

        return {
            "position_title": title,
            "company_name": company,
            "location": location,
            "description": description,
            "auth_wall": auth_wall,
        }
    except PWTimeout as exc:
        log.warning("playwright timeout for %s: %s", url, exc)
        _restart_browser()
        raise
    except Exception as exc:
        log.exception("scraping failed for %s: %s", url, exc)
        _restart_browser()
        raise
    finally:
        try:
            context.close()
        except Exception:
            pass


# -----------------------------------------------------------------------------
# Public-ATS fetcher — Greenhouse, Lever, Ashby, Workday, SmartRecruiters
# -----------------------------------------------------------------------------
#
# These ATS boards publish job descriptions on **public** URLs without
# an auth wall and most of them also publish a clean JSON API. We
# prefer the JSON API (much more reliable + lighter than rendering
# the SPA) and fall back to scraping the rendered HTML with Playwright
# when the API is not available.
#
# The cron is route-agnostic — it just stores whatever `source_url`
# the admin pasted. Below we detect the host and dispatch to the
# right fetcher. New providers can be added by extending the
# `PUBLIC_ATS_PROVIDERS` dict below.

import re as _re
import urllib.parse as _urlparse
from urllib.parse import parse_qsl, urlencode, urlunparse
import urllib.request as _urlrequest
import html as _html


def _host_of(url: str) -> str:
    """Return the lowercase host (no port, no path) of a URL. Falls
    back to '' for unparseable inputs."""
    try:
        return (_urlparse.urlparse(url).hostname or "").lower()
    except Exception:
        return ""


def _decode_entities(text: str) -> str:
    """Decode HTML entities (named, decimal, hex) and turn
    non-breaking spaces (literal U+00A0 OR entity-encoded `&nbsp;`
    variants) into regular spaces. iCIMS career pages emit
    `&nbsp;` between every word for layout reasons; we don't want
    those stored in `job_description`. Uses the stdlib
    `html.unescape` so we get every named entity for free
    (`&rsquo;`, `&ldquo;`, `&mdash;`, etc.)."""
    if not text:
        return text
    text = _html.unescape(text)
    # Belt-and-braces: also collapse literal non-breaking space
    # codepoints, in case the source had them as raw U+00A0.
    return text.replace("\u00a0", " ")


def _strip_html(html: str) -> str:
    """Best-effort HTML → text conversion. Keeps paragraph and line
    breaks so descriptions remain readable. We intentionally don't
    use a heavy dep like BeautifulSoup — these snippets are small.
    The Greenhouse/Lever JSON APIs return entity-escaped HTML (e.g.
    `&lt;div&gt;`), so we unescape BEFORE stripping tags."""
    if not html:
        return ""

    # The Greenhouse JSON API returns double-escaped HTML where tags
    # come through as `&lt;div&gt;`. Unescape first.
    text = (
        html.replace("&nbsp;", " ")
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", '"')
            .replace("&#39;", "'")
    )

    # Drop script / style blocks first (greedy across lines).
    text = _re.sub(r"<script\b[^>]*>.*?</script>", "", text, flags=_re.S | _re.I)
    text = _re.sub(r"<style\b[^>]*>.*?</style>", "", text, flags=_re.S | _re.I)

    # Convert block-level closers (and self-closing <br>) into
    # newlines so we don't run paragraphs together.
    text = _re.sub(r"<(?:/p|/div|/li|/h[1-6]|/tr|/section)\b[^>]*>", "\n", text, flags=_re.I)
    text = _re.sub(r"<br\s*/?>", "\n", text, flags=_re.I)

    # Strip everything that's still a tag.
    text = _re.sub(r"<[^>]+>", "", text)

    # Decode any remaining entities (e.g. `&rsquo;`, `&mdash;`,
    # numeric refs) and collapse non-breaking spaces.
    text = _decode_entities(text)

    # Collapse whitespace within each line, drop empty lines.
    lines = [_re.sub(r"[ \t]+", " ", ln).strip() for ln in text.split("\n")]
    return "\n".join([ln for ln in lines if ln]).strip()


def _http_get_json(url: str, timeout: float = 15.0):
    """Best-effort JSON GET. Returns the parsed object, or None on
    any failure. We don't use requests/flask here to keep this file's
    imports minimal."""
    try:
        req = _urlrequest.Request(url, headers={"User-Agent": USER_AGENT})
        with _urlrequest.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
        return json.loads(body)
    except Exception as exc:
        log.debug("JSON GET %s failed: %s", url, exc)
        return None


# -----------------------------------------------------------------------------
# Greenhouse
# -----------------------------------------------------------------------------
#
# Public URL shape:
#   https://boards.greenhouse.io/<board>/jobs/<id>
#   https://job-boards.greenhouse.io/<board>/jobs/<id>
#   https://boards.eu.greenhouse.io/<board>/jobs/<id>   (EU boards)
#
# Public JSON API:
#   https://boards-api.greenhouse.io/v1/boards/<board>/jobs/<id>?questions=false
#
# Both work without auth. The JSON API returns title, location, and
# HTML content; we strip the HTML to plain text. EU boards use the
# same API host (`boards-api.greenhouse.io`).

GH_BOARD_PATH = _re.compile(
    r"/(boards(?:\.eu)?|job-boards)\.greenhouse\.io/([^/]+)/jobs/(\d+)",
    _re.I,
)
# JobRight / iframe embeds: .../embed/job_app?for=<board>&token=<jobId>
GH_EMBED_QUERY = _re.compile(
    r"(?:[?&](?:for|board)=([^&]+)).*(?:[?&](?:token|gh_jid|job_id)=(-?\d+))"
    r"|(?:[?&](?:token|gh_jid|job_id)=(-?\d+)).*(?:[?&](?:for|board)=([^&]+))",
    _re.I,
)
# Company career wrappers (ZoomInfo): ?gh_jid=-8486808002 without a board token
GH_JID_ONLY = _re.compile(r"[?&](?:token|gh_jid|job_id)=(-?\d+)", _re.I)
GH_HOST_BOARDS = {
    "zoominfo.com": "zoominfo",
}
GH_CAREER_SUBDOMAINS = {
    "www", "careers", "jobs", "apply", "recruiting", "talent", "boards", "go",
}


def _normalize_greenhouse_job_id(raw: str | None) -> str | None:
    digits = _re.sub(r"\D", "", raw or "")
    return digits if len(digits) >= 5 else None


def _infer_greenhouse_board(host: str) -> str | None:
    host = (host or "").lower().rstrip(".")
    if not host or host.endswith("greenhouse.io"):
        return None
    if host in GH_HOST_BOARDS:
        return GH_HOST_BOARDS[host]
    no_www = host[4:] if host.startswith("www.") else host
    if no_www in GH_HOST_BOARDS:
        return GH_HOST_BOARDS[no_www]
    parts = no_www.split(".")
    if len(parts) < 2:
        return None
    if parts[0] in GH_CAREER_SUBDOMAINS and len(parts) >= 3:
        return parts[1]
    return parts[0] or None


def _parse_greenhouse_url(url: str, host: str) -> tuple[str | None, str | None, bool]:
    """Return (board, job_id, inferred). inferred=True for company ?gh_jid= pages."""
    m = GH_BOARD_PATH.search(url)
    if m and m.group(2).lower() != "embed":
        return m.group(2), m.group(3), False
    if "greenhouse.io" in (host or ""):
        em = GH_EMBED_QUERY.search(url)
        if em:
            board = em.group(1) or em.group(4)
            job_id = _normalize_greenhouse_job_id(em.group(2) or em.group(3))
            if board and job_id:
                return board, job_id, False
    jid = GH_JID_ONLY.search(url)
    if jid:
        job_id = _normalize_greenhouse_job_id(jid.group(1))
        board = _infer_greenhouse_board(host)
        if board and job_id:
            return board, job_id, True
    return None, None, False
GH_LEVER_HOST = "lever.co"
LEVER_PATH = _re.compile(r"lever\.co/([^/]+)(?:$|/)", _re.I)
# Ashby: jobs.ashbyhq.com/<board>/<uuid>
ASHBY_HOST = "ashbyhq.com"
ASHBY_PATH = _re.compile(r"jobs\.ashbyhq\.com/([^/]+)/([0-9a-f-]{8,})", _re.I)

# Gem: jobs.gem.com/<board>/<extId>
GEM_HOST = "jobs.gem.com"
GEM_PATH = _re.compile(r"jobs\.gem\.com/([^/?#]+)/([^/?#]+)", _re.I)
# iCIMS: careers-<org>.icims.com/jobs/<id>/<slug>/...
# Job ID is captured from the path; the slug is ignored. We need the
# URL pre-stripped of any trailing /apply or /login segments so
# that the `?in_iframe=1` variant serves the real job DOM instead of
# the form pages.
ICIMS_HOST = "icims.com"
ICIMS_PATH = _re.compile(r"\.icims\.com/jobs/(\d+)(/[^?#]*)?", _re.I)
# Tracks which URL suffixes mean "this is a sub-page, not the job".
# Users paste `/apply`, `/login`, `/intro`, `/preview`, etc. — the
# actual job data lives at `/job`.
_ICIMS_NON_JOB_SUFFIXES = ("/apply", "/login", "/intro", "/preview")

# JobVite: jobs.<company>.jobvite.com/jobs/<id>?...
# Or: jobs.jobvite.com/<company>/job/<id>?
JOBVITE_HOST = "jobvite.com"
JOBVITE_PATH = _re.compile(r"jobs?\.jobvite\.com(?:/[^/]+)?/jobs?/([^/?#]+)", _re.I)

# SuccessFactors (SAP): used by Gainwell and many enterprises.
# URLs look like https://jobs.<company>.com/job/<location>/<id>/
# (sometimes with a trailing slash, sometimes without). The job id
# is a numeric id in the second URL segment.
SUCCESSFACTORS_HOST = "successfactors.com"
SUCCESSFACTORS_PATH = _re.compile(
    r"/job/(?:[^/]+/)?(\d{5,})(?:/|$|\?|#)", _re.I
)

# Workday: *.wd[1-5].myworkdayjobs.com/<tenant>/job/<location>/<title>_<id>
# Workday serves schema.org/JobPosting JSON-LD on every job page,
# which the generic renderer can parse. We only need to confirm the
# URL shape matches.
WORKDAY_HOST = "myworkdayjobs.com"

# Paycom: paycomonline.net/v4/ats/web.php/portal/<clientkey>/jobs/<id>
# Paycom is an SPA — the page body is empty until JS runs. We rely
# on OG meta tags (`og:title`, `og:description`) which the server
# renders for SEO. Title contains the job ID in parentheses.
PAYCOM_HOST = "paycomonline.net"

# ApplyToJob: <company>.applytojob.com/apply/<key>/<slug>
# OG meta carries title + company; body comes from generic renderer.
APPLYTOJOB_HOST = "applytojob.com"

# Rippling ATS: ats.rippling.com/<tenant>/jobs/<uuid>
# OG meta carries title + description.
RIPLING_HOST = "ats.rippling.com"

# Paylocity ATS: recruiting.paylocity.com/Recruiting/Jobs/Apply/<id>/<slug>
# (or /Recruiting/Jobs/Apply/<id> with no slug). The Apply page is
# a multi-step form (Step 1 of 5) and doesn't contain the job
# description. The actual job details live at:
#   https://recruiting.paylocity.com/Recruiting/Jobs/Details/<id>
# The details page is server-rendered HTML with the title, location,
# and full description right in the body — no JSON-LD, no JS-only
# rendering, no auth. We rewrite the URL to the details variant
# before fetching.
PAYLOCITY_HOST = "recruiting.paylocity.com"
PAYLOCITY_APPLY_PATH = _re.compile(
    r"recruiting\.paylocity\.com/Recruiting/Jobs/Apply/(\d+)(?:/[^?#]*)?(?:\?.*)?$",
    _re.I,
)
PAYLOCITY_DETAILS_PATH = _re.compile(
    r"recruiting\.paylocity\.com/Recruiting/Jobs/Details/(\d+)(?:/[^?#]*)?(?:\?.*)?$",
    _re.I,
)


def _fetch_greenhouse(url: str, host: str, board_token: str, job_id: str) -> dict | None:
    """Pull structured data from Greenhouse. Returns a dict in the
    canonical response shape, or None on failure / 404. We hit the
    JSON API first; the SPA fallback is only for malformed boards
    that don't expose the API (rare).

    Greenhouse 404 behaviour: their JSON API returns
    `{"status":404,"error":"Job not found"}` for a non-existent job.
    The HTML page is the company's index — `<title>Jobs at X</title>`
    — which is misleading. We translate the 404 to `None` so the
    Node side records an informative error and the admin knows
    the URL was wrong, not that LinkedIn's auth wall blocked us."""
    api = (
        f"https://boards-api.greenhouse.io/v1/boards/"
        f"{_urlparse.quote(board_token)}/jobs/{job_id}?questions=false"
    )
    j = _http_get_json(api)
    if j and isinstance(j, dict):
        if j.get("status") == 404 or not j.get("title"):
            log.info("Greenhouse: job %s on board %s not found", job_id, board_token)
            return None
        # Company-name resolution: Greenhouse's JSON API exposes
        # `company_name` on most boards. When it's missing (some
        # boards don't fill it), fall back to the URL slug which
        # is *always* the company identifier on Greenhouse (the
        # board path is `boards.greenhouse.io/<company>/jobs/...`).
        # As a last resort, use the first department entry — some
        # single-product companies use the only department as a
        # stand-in for the company name.
        company = (
            (j.get("company_name") or "").strip()
            or board_token.replace("-", " ").title()
        )
        if not company and isinstance(j.get("departments"), list) and j["departments"]:
            company = (j["departments"][0] or {}).get("name") or ""
        return {
            "position_title": (j.get("title") or "").strip() or None,
            "company_name": company or None,
            "location": (j.get("location") or {}).get("name") if isinstance(j.get("location"), dict) else None,
            "description": _strip_html(j.get("content") or ""),
            "auth_wall": False,
        }
    return None


def _fetch_lever(url: str, host: str, company: str, _unused: str = "") -> dict | None:
    """Lever's postings API is public per company.

    API: https://api.lever.co/v0/postings/<company>?mode=json
    """
    api = f"https://api.lever.co/v0/postings/{_urlparse.quote(company)}?mode=json"
    j = _http_get_json(api)
    if j and isinstance(j, list):
        # Posting list from Lever's public API. Matching requires a
        # posting UUID in the URL — never fall back to an arbitrary
        # posting from the board.
        postings = j  # list of {id, title, content, categories, ...}
        if not postings:
            return None
        # If the URL mentions a specific posting id, require a match.
        # Never fall back to postings[0] — that silently scrapes the
        # wrong job when the id is missing or mistyped.
        url_id = None
        m = _re.search(r"/([0-9a-f-]{36,})", url)
        if m:
            url_id = m.group(1)
        if url_id:
            pick = next((p for p in postings if p.get("id") == url_id), None)
            if pick is None:
                log.info("Lever: posting %s not found on board %s", url_id, company)
                return None
        else:
            # Board / listing URL with no posting id — not scrapeable
            # as a single job.
            log.info("Lever: no posting id in URL for company %s", company)
            return None
        # Lever's public API is a bit inconsistent across postings:
        # • `title` is null on many postings, with the real title in
        #   `text` instead. Fall back to `text` whenever `title` is
        #   missing/empty.
        # • The full job body is **typically** stored in the `lists`
        #   array — a list of `{text, content}` blocks (HTML). The
        #   legacy top-level `content` / `description` / `descriptionPlain`
        #   fields only carry the *opening* paragraph on newer
        #   postings (e.g. Curai returns the company tagline in
        #   `descriptionPlain` and the role body in `lists[*].content`).
        #   We concatenate `lists[*].content` (HTML → plain text) and
        #   fall back to the legacy fields if `lists` is empty.
        # • `additionalPlainText` is appended to the main body on
        #   older postings.
        position_title = pick.get("title") or pick.get("text") or None
        if position_title:
            position_title = position_title.strip()
        # Build the description from `lists[*]` first (newer API
        # shape), then fall back to the legacy top-level fields.
        list_blocks = pick.get("lists") or []
        list_html = "\n\n".join(
            (blk.get("content") or "") for blk in list_blocks if isinstance(blk, dict)
        ).strip()
        description = (
            _strip_html(list_html)
            or _strip_html(pick.get("content") or "")
            or _strip_html(pick.get("description") or "")
            or _strip_html(pick.get("descriptionPlain") or "")
            or _strip_html(pick.get("additionalPlainText") or "")
        )
        # Company name: the URL slug is the most reliable source
        # for Lever (e.g. `jobs.lever.co/curai/...` → "Curai").
        # Title-case it so it doesn't render as "curai" in the UI.
        company_name = (company or "").replace("-", " ").strip().title() or None
        return {
            "position_title": position_title,
            "company_name": company_name,
            "location": (pick.get("categories") or {}).get("location"),
            "description": description,
            "auth_wall": False,
        }
    return None


def _fetch_ashby(url: str, host: str, board: str, posting_id: str) -> dict | None:
    """Pull structured data from Ashby's public posting API.

    Public URL shape:
        https://jobs.ashbyhq.com/<board>/<posting-uuid>
    Public JSON API:
        https://api.ashbyhq.com/posting-api/job-board/<board>?includeCompensation=true

    The board endpoint returns ALL postings on the board; we filter
    by `id` (the posting UUID from the user's link). Ashby doesn't
    have a per-posting endpoint, so we hit the board once per scrape.
    The board token is the URL segment between `jobs.ashbyhq.com/`
    and the UUID (e.g. `payabli`)."""
    api = (
        f"https://api.ashbyhq.com/posting-api/job-board/"
        f"{_urlparse.quote(board)}?includeCompensation=true"
    )
    j = _http_get_json(api)
    if not j or not isinstance(j, dict):
        return None
    jobs = j.get("jobs")
    if not isinstance(jobs, list) or not jobs:
        log.info("Ashby: board %s returned no jobs", board)
        return None
    pick = next((p for p in jobs if p.get("id") == posting_id), None)
    if not pick:
        # If the user posted an Ashby URL but the specific posting
        # isn't on the board's listing, treat it as a 404 — don't
        # silently return whatever's most recent (that would store
        # the wrong job's data).
        log.info("Ashby: posting %s not found on board %s", posting_id, board)
        return None
    location = pick.get("location")
    if not location and pick.get("isRemote"):
        location = "Remote"
    # Company name resolution: Ashby's JSON API exposes a `department`
    # field per posting, but NOT a top-level company name — the
    # company IS the board token from the URL (e.g. `payabli`).
    # Prefer that; fall back to the department only when the URL
    # slug is missing.
    company = (board or "").replace("-", " ").title()
    if not company and pick.get("department"):
        company = pick["department"]
    return {
        "position_title": (pick.get("title") or "").strip() or None,
        "company_name": company or None,
        "location": location,
        "description": _strip_html(
            pick.get("descriptionPlain") or pick.get("descriptionHtml") or ""
        ),
        "auth_wall": False,
    }


def _fetch_gem(url: str, host: str, board_id: str, ext_id: str) -> dict | None:
    """Pull JD from Gem's public GraphQL batch API.

    Public URL: https://jobs.gem.com/<board>/<extId>
    Endpoint:   POST https://jobs.gem.com/api/public/graphql/batch
    Requires header batch: true (SPA HTML alone has no job body).
    """
    endpoint = "https://jobs.gem.com/api/public/graphql/batch"
    payload = [{
        "operationName": "ExternalJobPostingQuery",
        "variables": {"boardId": board_id, "extId": ext_id},
        "query": (
            "query ExternalJobPostingQuery($boardId: String!, $extId: String!) {\n"
            "  oatsExternalJobPosting(boardId: $boardId, extId: $extId) {\n"
            "    id title descriptionHtml extId\n"
            "    locations { id name city isoCountry isRemote }\n"
            "    job { id department { id name } locationType employmentType }\n"
            "    jobPostSectionHtml { introHtml outroHtml }\n"
            "    compensationHtml\n"
            "  }\n"
            "  jobBoardExternal(vanityUrlPath: $boardId) {\n"
            "    id teamDisplayName pageTitle\n"
            "  }\n"
            "}"
        ),
    }]
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "batch": "true",
        "Origin": "https://jobs.gem.com",
        "Referer": f"https://jobs.gem.com/{board_id}/{ext_id}",
    }
    try:
        import requests as _requests
        res = _requests.post(endpoint, json=payload, headers=headers, timeout=45)
    except Exception as exc:
        log.info("Gem GraphQL failed for %s/%s: %s", board_id, ext_id, exc)
        return None
    if res.status_code != 200:
        log.info("Gem GraphQL status %s for %s/%s", res.status_code, board_id, ext_id)
        return None
    raw = res.json()
    envelopes = raw if isinstance(raw, list) else ([raw] if raw else [])
    env = next(
        (e for e in envelopes if isinstance(e, dict) and (e.get("data") or {}).get("oatsExternalJobPosting")),
        envelopes[0] if envelopes else None,
    )
    data = (env or {}).get("data") or {}
    posting = data.get("oatsExternalJobPosting") or {}
    if not posting or not posting.get("title"):
        # REST fallback — list board posts and match extId / absolute_url.
        try:
            rest = _http_get_json(
                f"https://api.gem.com/job_board/v0/{_urlparse.quote(board_id)}/job_posts/"
            )
        except Exception:
            rest = None
        if isinstance(rest, list):
            pick = next(
                (
                    j for j in rest
                    if isinstance(j, dict) and (
                        ext_id in str(j.get("absolute_url") or "")
                        or str(j.get("id") or "") == ext_id
                        or str(j.get("external_id") or "") == ext_id
                    )
                ),
                None,
            )
            if pick:
                desc = _strip_html(pick.get("content") or pick.get("description") or "")
                if desc and len(desc) >= 40:
                    company = (board_id or "").replace("-", " ").title()
                    return {
                        "position_title": (pick.get("title") or pick.get("name") or "").strip() or None,
                        "company_name": company or None,
                        "location": pick.get("location") or None,
                        "description": desc,
                        "auth_wall": False,
                    }
        return None

    board_meta = data.get("jobBoardExternal") or {}
    sections = posting.get("jobPostSectionHtml") or {}
    html_parts = "\n".join(
        p for p in (
            sections.get("introHtml"),
            posting.get("descriptionHtml"),
            posting.get("compensationHtml"),
            sections.get("outroHtml"),
        ) if p
    )
    desc = _strip_html(html_parts)
    if not desc or len(desc) < 40:
        return None
    locs = posting.get("locations") or []
    location_bits = [
        (l.get("name") or l.get("city") or "").strip()
        for l in locs if isinstance(l, dict)
    ]
    location = "; ".join(b for b in location_bits if b) or None
    if not location and any(isinstance(l, dict) and l.get("isRemote") for l in locs):
        location = "Remote"
    company = (board_meta.get("teamDisplayName") or board_meta.get("pageTitle") or "")
    company = _re.sub(r"\s+careers$", "", company, flags=_re.I).strip()
    if not company:
        company = (board_id or "").replace("-", " ").title()
    return {
        "position_title": (posting.get("title") or "").strip() or None,
        "company_name": company or None,
        "location": location,
        "description": desc,
        "auth_wall": False,
    }


def _normalise_icims_url(url: str) -> str | None:
    """Strip tracking params and `/apply|/login|...` suffixes from
    an iCIMS URL, returning a canonical `.../job?in_iframe=1` URL.

    Returns None if the URL isn't an iCIMS job URL. The `?in_iframe=1`
    query is what tells iCIMS to serve the full job DOM rather than
    the company landing page (which is what bare URLs return)."""
    m = ICIMS_PATH.search(url)
    if not m:
        return None
    job_id = m.group(1)
    # Derive the host: prefer the iCIMS subdomain as written.
    parsed = _urlparse.urlparse(url)
    host = parsed.hostname or ""
    scheme = parsed.scheme or "https"
    return f"{scheme}://{host}/jobs/{job_id}/job?in_iframe=1"


def _normalise_lever_url(url: str) -> str | None:
    """Rewrite Lever `/apply` (+ tracking query) → posting JD page.

    JobRight and similar aggregators paste:
      https://jobs.lever.co/<company>/<uuid>/apply?utm_source=...
    The apply page is the form only (no `.posting-description`).
    The posting page without `/apply` carries the full JD.

    Returns None if the URL is not a Lever posting URL.
    """
    if "lever.co" not in (url or "").lower():
        return None
    m = _re.search(
        r"(https?://[^/]*lever\.co)/([^/?#]+)/([0-9a-f-]{36,})",
        url,
        _re.I,
    )
    if not m:
        return None
    return f"{m.group(1)}/{m.group(2)}/{m.group(3)}"


# Workday job URLs follow this shape:
#   <host>/<tenant>/job/<location>/<title>_<id>
# e.g.
#   https://wgu.wd5.myworkdayjobs.com/External/job/Salt-Lake-City-UT/Principal-Software-Engineer_JR-025248
#   https://salesforce.wd12.myworkdayjobs.com/external_career_site/job/California---Remote/Senior-..._JR343618
#
# Tracking wrappers (jobright, LinkedIn, LinkedIn's spm=... param,
# aggregator jr_id=...) append `?source=...&jr_id=...` to the URL.
# Workday's JS router tolerates them but they occasionally confuse
# the SPA navigation and produce a stripped/empty job body. We
# drop them here before the fetch.
#
# We also use this regex to validate the path shape: any URL that
# claims to be a Workday job but doesn't match `/<tenant>/job/...`
# is rejected up-front (caller gets a None and surfaces an
# accurate `fetch_error` instead of generic renderer returning
# the company career-portal index).
WORKDAY_PATH = _re.compile(
    r"^/(?P<tenant>[^/]+)/job/(?P<loc>[^/]+)/(?P<rest>.+?)/?$",
    _re.I,
)
# Tracking params known to break Workday's SPA. Anything in this
# list is dropped; the rest of the query string is preserved.
WORKDAY_TRACKING_PARAMS = {
    # Aggregator wrappers
    "source", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "jr_id", "spm", "ref", "refId", "trackingId",
    # LinkedIn / jobright-specific
    "trk", "trkEmail", "lipi", "midToken", "midSig",
}


def _normalise_workday_url(url: str) -> str | None:
    """Strip Workday-tracking query params and validate the path
    shape. Returns the canonical job URL or None if the URL isn't
    a recognisable Workday job URL.

    Tracking params that occasionally confuse Workday's JS router
    (spm, source, jr_id, utm_*) are removed; everything else is
    kept. The host and path are preserved verbatim so the tenant
    detection in the company-name fallback still works."""
    parsed = _urlparse.urlparse(url)
    host = (parsed.hostname or "").lower()
    if WORKDAY_HOST not in host:
        return None
    # Validate path shape. Workday URLs without the /job/<loc>/<rest>
    # structure (e.g. a tenant home page or a search results URL)
    # return None so the caller can refuse rather than fall through
    # to the generic renderer and store the company index page as
    # "job data".
    path = parsed.path or ""
    if not WORKDAY_PATH.search(path):
        return None
    # Drop tracking params.
    if parsed.query:
        pairs = parse_qsl(parsed.query, keep_blank_values=True)
        kept = [(k, v) for (k, v) in pairs if k not in WORKDAY_TRACKING_PARAMS]
        new_query = urlencode(kept)
    else:
        new_query = ""
    return urlunparse((
        parsed.scheme or "https",
        parsed.netloc or "",
        path,
        parsed.params or "",
        new_query,
        ""  # drop fragment
    ))


def _fetch_icims(url: str, host: str, _board: str = "", _unused: str = "") -> dict | None:
    """Fetch an iCIMS job page and extract the title, location, and
    description.

    iCIMS job URLs come in many shapes — pasted by users, they often
    end in `/apply` or `/login`, which serve different forms (and
    not the job body). We rewrite to `/job?in_iframe=1` so iCIMS
    serves the full job DOM inline rather than as an iFrame inside
    the company landing page.

    Plain HTTP fetch works fine here — the iCIMS job DOM is fully
    rendered server-side when `?in_iframe=1` is on the URL. iCIMS
    serves a Human Verification CAPTCHA to headless browsers but
    doesn't seem to flag plain `requests` clients, so we skip
    Playwright and parse the HTML directly with regex.

    Layout of the iFrame variant:
      - `<title>` element holds the full title + location
        (e.g. "Software Engineer - .NET in INDIANAPOLIS, Indiana |
         Careers at eimagine")
      - `.iCIMS_JobContent` is a single block: title | ID | Job
        Locations | <loc> | Type | <type> | ... | Options
      - `.iCIMS_InfoMsg_Job` divs each contain one body section
        (Overview, Skills, Education, etc.)
    """
    target = _normalise_icims_url(url)
    if not target:
        return None
    # Pull the org token out of `careers-<org>.icims.com` as a
    # fallback company name — iCIMS career pages don't always
    # include the company name in the body.
    org = ""
    m = _re.search(r"careers-([^.\s]+)\.icims\.com", host or target)
    if m:
        org = m.group(1).replace("-", " ").title()
    log.info("iCIMS fetch: %s (org=%s)", target, org)
    try:
        # iCIMS' WAF serves HTTP 405 to any request with a Chrome
        # User-Agent once the IP has been flagged. The page is
        # fully rendered server-side when `?in_iframe=1` is in
        # the URL — no JS execution needed — so we can fetch it
        # with a generic client. We deliberately DON'T use a
        # browser UA here because the WAF treats Chrome as a bot
        # signal in this case. A plain `python-requests/<ver>`
        # UA gets through.
        import requests as _requests
        # Use a generic `python-requests/<ver>` UA explicitly. iCIMS
        # WAF treats Chrome UAs as a bot signal here; `requests`'s
        # default UA works because it doesn't look like a browser.
        resp = _requests.get(
            target,
            headers={
                "User-Agent": _requests.utils.default_user_agent(),
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            },
            timeout=20,
            allow_redirects=True,
        )
        if resp.status_code >= 400:
            log.warning("iCIMS fetch returned HTTP %s for %s", resp.status_code, target)
            return None
        html = resp.text
    except Exception as exc:
        log.warning("iCIMS fetch failed: %s", exc)
        return None
    if "Human Verification" in html or "iCIMS_JobContent" not in html:
        log.info("iCIMS: bot challenge or missing job DOM on %s", target)
        return None

    # Title: read from <title> element if it follows the standard
    # `X in LOCATION | Careers at COMPANY` shape, else fall back to
    # the .iCIMS_JobContent text before the ID row.
    page_title_m = _re.search(r"<title>([^<]+)</title>", html, _re.I)
    page_title = page_title_m.group(1).strip() if page_title_m else ""
    # Pattern is "<job title> in <location> | Careers at <company>"
    full_m = _re.search(
        r"^\s*(?P<title>[^|]+?)\s+in\s+(?P<loc>[^|]+?)\s*\|\s*Careers at\s+(?P<comp>[^<]+?)\s*$",
        page_title,
    )
    title = None
    location = None
    if full_m:
        title = full_m.group("title").strip()
        location = full_m.group("loc").strip()
        company = full_m.group("comp").strip()
    else:
        company = None
        # Fallback: parse the iCIMS_JobContent text
        content_m = _re.search(
            r"iCIMS_JobContent[^>]*>(.+?)</div>",
            html,
            _re.S | _re.I,
        )
        if content_m:
            content_text = _re.sub(
                r"<[^>]+>", " ", content_m.group(1)
            )
            content_text = _re.sub(r"\s+", " ", content_text).strip()
            # Title is the text before "ID <number>".
            id_m = _re.search(r"^(.+?)\s+ID\s+\d", content_text)
            if id_m:
                title = id_m.group(1).strip()
            # Location: text between "Job Locations" and the next label.
            loc_m = _re.search(
                r"Job Locations\s+(.+?)(?:\s+Type\s+|\s+ID\s+|\s+Options\s+|\s+Overview\s+|$)",
                content_text,
            )
            if loc_m:
                location = loc_m.group(1).strip() or None
    if not company:
        company = org or None

    # Description: each section lives in its own `iCIMS_InfoMsg_Job`
    # div. Concatenate plain-text bodies, separated by blank lines.
    description_parts = []
    for sec in _re.finditer(
        r"iCIMS_InfoMsg_Job[^>]*>(.+?)</div>",
        html,
        _re.S | _re.I,
    ):
        body = _re.sub(r"<[^>]+>", " ", sec.group(1))
        body = _decode_entities(body)
        body = _re.sub(r"\s+", " ", body).strip()
        if body:
            description_parts.append(body)
    description = "\n\n".join(description_parts) if description_parts else None

    if not title and not description:
        log.info("iCIMS: no job DOM rendered for %s", target)
        return None

    return {
        "position_title": title,
        "company_name": company,
        "location": location,
        "description": description,
        "auth_wall": False,
    }


# -----------------------------------------------------------------------------
# JobVite
# -----------------------------------------------------------------------------
#
# Public URL shape:
#   https://jobs.<company>.jobvite.com/jobs/<id>?...
# Or:
#   https://jobs.jobvite.com/<company>/job/<id>?...
#
# The page is server-rendered with the job content inline. We pull
# the title from `<title>` ("<title> at <company> Careers"), the
# description from `.jv-job-detail-description`, and the
# location/department from `.jv-job-detail-meta` (rendered as
# `Department | Location | Salary | ...` separated by `|`).

def _fetch_jobvite(url: str, host: str, _a: str = "", _b: str = "") -> dict | None:
    """Pull structured data from JobVite's server-rendered HTML."""
    try:
        import requests as _requests
        resp = _requests.get(
            url,
            headers={
                "User-Agent": _requests.utils.default_user_agent(),
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            },
            timeout=20,
            allow_redirects=True,
        )
        if resp.status_code >= 400:
            log.info("JobVite fetch returned HTTP %s for %s", resp.status_code, url)
            return None
        html = resp.text
    except Exception as exc:
        log.warning("JobVite fetch failed: %s", exc)
        return None

    # Title from `<title>` which JobVite formats as one of:
    #   "<company> Careers - <job title>"        (most common)
    #   "<job title> at <company> Careers"      (variant)
    #   "<job title> Careers at <company>"      (variant)
    page_title_m = _re.search(r"<title>([^<]+)</title>", html, _re.I)
    page_title = page_title_m.group(1).strip() if page_title_m else ""
    title = None
    company = None
    if page_title:
        # First: "<company> Careers - <title>" — strip the trailing
        # "Careers" or "Careers - <title>" and split on " - ".
        m_company_first = _re.match(
            r"^(?P<c>.+?)\s+Careers?\s*(?:[-—]\s*(?P<t>.+))?$",
            page_title,
            _re.I,
        )
        if m_company_first and (m_company_first.group("t") or "Careers" in page_title):
            company = m_company_first.group("c").strip()
            title = (m_company_first.group("t") or "").strip() or None
        else:
            # Fallback: "<title> at <company> Careers" / "Jobs"
            cleaned = _re.sub(r"\s*(?:Careers?|Jobs?|Career Page)\s*$", "", page_title, _re.I).strip()
            at_m = _re.match(r"^(?P<t>[^@]+?)\s+at\s+(?P<c>.+?)\s*$", cleaned)
            if at_m:
                title = at_m.group("t").strip()
                company = at_m.group("c").strip()
            else:
                title = cleaned
                company = None

    # Company from URL slug if we didn't get it from the title.
    if not company:
        slug_m = _re.search(
            r"jobs?\.jobvite\.com/([^/]+?)(?:/job(?:s)?)?/[^/]+/?$", url
        )
        if slug_m:
            company = slug_m.group(1).replace("-", " ").title()

    # Description: `.jv-job-detail-description` div. The div contains
    # the full job posting with nested divs; a naive `</div>` match
    # would stop at the first inner closing tag. We anchor to the
    # next sibling (`.jv-job-detail-meta`, `.jv-job-detail-bottom-actions`,
    # etc.) instead.
    desc = None
    desc_m = _re.search(
        r'class="[^"]*jv-job-detail-description[^"]*"[^>]*>(.+?)(?=<div\s+class="(?:jv-)?(?:job-detail-(?:meta|bottom-actions|share)|jv-share|jobdetail))',
        html,
        _re.S | _re.I,
    )
    if not desc_m:
        # Fallback: simple greedy match to the next div (best effort).
        desc_m = _re.search(
            r'class="[^"]*jv-job-detail-description[^"]*"[^>]*>(.+?)(?=<div)',
            html,
            _re.S | _re.I,
        )
    if desc_m:
        text = _re.sub(r"<[^>]+>", " ", desc_m.group(1))
        text = _decode_entities(text)
        text = _re.sub(r"\s+", " ", text).strip()
        desc = text or None

    # Location: `.jv-job-detail-meta` block, items separated by `|`.
    # Format: Department | City, State | Salary | ...
    location = None
    meta_m = _re.search(
        r'class="[^"]*jv-job-detail-meta[^"]*"[^>]*>(.+?)</div>',
        html,
        _re.S | _re.I,
    )
    if meta_m:
        meta_text = _re.sub(r"<[^>]+>", "|", meta_m.group(1))
        meta_text = _decode_entities(meta_text)
        meta_text = _re.sub(r"\s+", " ", meta_text).strip()
        # The first or second `|`-separated cell is usually the city.
        # We pull the first cell that ends in a 2-letter US state
        # abbreviation or a country name. As a fallback we take the
        # second cell (skipping Department).
        cells = [c.strip() for c in meta_text.split("|") if c.strip()]
        for cell in cells:
            if _re.search(r",\s*[A-Z]{2}\b|\bUSA?\b|\bCanada\b|\bRemote\b", cell):
                location = cell
                break
        if not location and len(cells) >= 2:
            location = cells[1]

    if not title and not desc:
        log.info("JobVite: no job DOM rendered for %s", url)
        return None

    return {
        "position_title": title,
        "company_name": company,
        "location": location,
        "description": desc,
        "auth_wall": False,
    }


# -----------------------------------------------------------------------------
# SuccessFactors (SAP) — used by Gainwell, Adobe, and many enterprises.
# -----------------------------------------------------------------------------
#
# Public URL shape (very variable; we accept any path with a numeric
# job id at the end):
#   https://jobs.<company>.com/job/<location-slug>/<numeric-id>/
#   https://<tenant>.jobs.sapsf.com/...
#
# The page body carries the description in a div with class
# `jobdescription`. Title is in `<title>` ("<title> Job Details | <company>")
# and location is in `.joblocation` / `.jobdata` lists.

def _fetch_successfactors(url: str, host: str, _a: str = "", _b: str = "") -> dict | None:
    """Pull structured data from a SuccessFactors careers page."""
    try:
        import requests as _requests
        resp = _requests.get(
            url,
            headers={
                "User-Agent": _requests.utils.default_user_agent(),
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            },
            timeout=20,
            allow_redirects=True,
        )
        if resp.status_code >= 400:
            log.info("SuccessFactors fetch returned HTTP %s for %s", resp.status_code, url)
            return None
        html = resp.text
    except Exception as exc:
        log.warning("SuccessFactors fetch failed: %s", exc)
        return None

    # Title from `<title>` — typical format:
    # "<job title> Job Details | <company>"
    page_title_m = _re.search(r"<title>([^<]+)</title>", html, _re.I)
    page_title = page_title_m.group(1).strip() if page_title_m else ""
    title = None
    company = None
    if page_title:
        # Drop "Job Details" / "Careers" / "Jobs" / "Career Page"
        # anywhere in the title — these tags are noise we don't want
        # stored in `position_title`. We then split on "|" so we can
        # pick up the company name on the right side.
        cleaned = _re.sub(
            r"\s*(?:Job Details|Careers?|Jobs?|Career Page)\s*",
            " | ",
            page_title,
            _re.I,
        ).strip()
        # Collapse repeated `|` separators left behind by the replace.
        cleaned = _re.sub(r"(?:\s*\|\s*){2,}", " | ", cleaned).strip(" |")
        if "|" in cleaned:
            parts = [p.strip() for p in cleaned.split("|")]
            title = parts[0]
            company = parts[-1] if len(parts) > 1 else None
        else:
            title = cleaned

    # Company fallback from URL hostname
    if not company:
        host_m = _re.match(r"jobs?\.([^.]+)\.", host or "")
        if host_m:
            company = host_m.group(1).replace("-", " ").title()

    # Description: `.jobdescription` div. The actual job description
    # is the full content of this `<div>` and any nested divs inside
    # it. A naive `(.+?)</div>` regex stops at the FIRST inner
    # `</div>` and only captures the company boilerplate, so we
    # instead terminate the match at the next sibling `<div>` that
    # starts a new section (joblocation / jobdata / similar-jobs).
    desc = None
    # Use a lookahead that ends right before the next top-level
    # sibling div — `class="joblocation"`, `class="jobdata"`,
    # `id="similar-jobs"`, `class="jobEEO"`, etc.
    desc_m = _re.search(
        r'class="[^"]*jobdescription[^"]*"[^>]*>(.+?)(?=<div\s+(?:class="(?:joblocation|jobdata|similar-?jobs|jobeeo|job)?[a-z\-]*"|id="(?:similar-?jobs|jobeeo|description)"))',
        html,
        _re.S | _re.I,
    )
    if desc_m:
        body = desc_m.group(1)
        text = _re.sub(r"<[^>]+>", " ", body)
        # Strip any CSS rules / inline style noise that slipped into
        # the body (SuccessFactors embeds full stylesheets).
        text = _re.sub(r"#[a-zA-Z][\w\.\-]*\s*\{[^}]*\}", "", text)
        text = _re.sub(r"/\*.*?\*/", "", text, flags=_re.S)
        text = _decode_entities(text)
        text = _re.sub(r"\s+", " ", text).strip()
        desc = text or None

    # Location: `.joblocation` div (or `.jobdata` lists).
    location = None
    loc_m = _re.search(
        r'class="[^"]*joblocation[^"]*"[^>]*>(.+?)</div>',
        html,
        _re.S | _re.I,
    )
    if loc_m:
        text = _re.sub(r"<[^>]+>", " ", loc_m.group(1))
        # Some SuccessFactors pages include inline CSS comments or
        # CSS selector rules in the location div (e.g. `#job-location
        # .job-location-inline { display: inline; }`). Strip those.
        text = _re.sub(r"#[a-zA-Z][\w\.\-]*\s*\{[^}]*\}", "", text)
        text = _re.sub(r"/\*.*?\*/", "", text, flags=_re.S)
        text = _decode_entities(text)
        location = _re.sub(r"\s+", " ", text).strip() or None

    if not title and not desc:
        log.info("SuccessFactors: no job DOM rendered for %s", url)
        return None

    return {
        "position_title": title,
        "company_name": company,
        "location": location,
        "description": desc,
        "auth_wall": False,
    }


# -----------------------------------------------------------------------------
# Rippling ATS — ats.rippling.com/<tenant>/jobs/<uuid>
# -----------------------------------------------------------------------------
#
# Rippling is a Next.js SPA. The server-rendered HTML only carries OG
# meta tags and a truncated `og:description`; the full job body lives
# in the React component tree, so we have to render the page with
# Playwright and then read the post-hydration DOM. The page uses the
# following layout once hydrated:
#
#   - `<title>` is the page navigation breadcrumb
#     (e.g. "Senior Backend Engineer | Current Openings"), so we
#     ignore it and use the React `<h1>` instead which carries the
#     real job title.
#   - The body sits inside `<div ... data-rbd-droppable-id="job-...">`
#     or `.ats-job-description`, depending on the template version.
#     We try a small set of selectors and take whichever has content.
#   - The tenant (company) name is in the URL slug, e.g.
#     `ats.rippling.com/franki/...` → "Franki".

def _fetch_rippling(url: str, host: str, _a: str = "", _b: str = "") -> dict | None:
    """Render a Rippling ATS page with Playwright and pull the
    full job body. Rippling's templates vary across tenants — the
    page uses Next.js and the body is built up by React after
    hydration. We don't get a clean `<h1>` or `.job-description`
    container to scrape, so we walk the rendered DOM to extract
    the title from `<title>` (which carries just the job name)
    and the description from the longest inner-text block on the
    page that isn't the navigation/footer."""
    log.info("Rippling render: %s", url)
    browser = _start_browser()
    context = browser.new_context(
        user_agent=USER_AGENT,
        viewport={"width": 1280, "height": 800},
        locale="en-US",
        timezone_id="America/New_York",
        extra_http_headers={"Accept-Language": "en-US,en;q=0.9"},
    )
    context.add_init_script(
        "Object.defineProperty(navigator, 'webdriver', {get: () => undefined});"
    )
    page = context.new_page()
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=30_000)
        # Wait for React hydration to swap the OG-only skeleton for
        # the full job DOM. The body text expands dramatically once
        # the React tree mounts.
        page.wait_for_timeout(5000)

        # Title: `<title>` is just the job name on Rippling. We
        # strip the trailing " | Current Openings" breadcrumb suffix
        # when present.
        title_raw = page.title()
        title = None
        if title_raw:
            cleaned = _re.sub(
                r"\s*\|\s*Current Openings\s*$",
                "",
                title_raw,
                _re.I,
            ).strip()
            title = cleaned or None

        # Company name from URL slug: "ats.rippling.com/<tenant>/jobs/..."
        company = None
        slug_m = _re.search(r"ats\.rippling\.com/([^/]+)/", url)
        if slug_m:
            company = slug_m.group(1).replace("-", " ").title()

        # Description: walk every <div>/<section>/<article>/<main>
        # on the page and pick the innerText block with the most
        # content (excluding <body> itself, which concatenates
        # everything). This works across Rippling's template
        # variants without depending on a specific class name.
        #
        # The previous version rejected any block whose text
        # matched `/Terms of service|Privacy|Cookies/i`. That
        # ended up filtering out EVERY block on Rippling pages,
        # because Rippling's persistent cookie banner ("We use
        # Cookies") lives in the outer React tree and gets
        # included in every innerText read. We now only reject
        # blocks that are PRIMARILY footer chrome (legal/cookie
        # text dominates the block) instead of any block that
        # merely mentions those words. We also subtract the
        # chrome length from the score so a 500-char block with
        # 200 chars of cookie banner scores lower than a 500-char
        # block with no chrome.
        description = page.evaluate("""() => {
            let best = null;
            let bestScore = 0;
            const FOOTER_HINT = /terms of service|privacy policy|cookie policy|all rights reserved|powered by rippling/i;
            document.querySelectorAll('div, section, article, main').forEach(el => {
                const t = (el.innerText || '').trim();
                if (t.length < 500) return;
                // Estimate how much of the block is footer chrome
                // by counting characters inside FOOTER_HINT
                // sentences. If more than 40% of the text is
                // chrome, skip it. Otherwise subtract the chrome
                // length from the score so a candidate with a
                // short footer hints ranks below a clean one.
                let chromeLen = 0;
                let m;
                const re = new RegExp(FOOTER_HINT.source, 'gi');
                while ((m = re.exec(t)) !== null) {
                    // Mark the sentence boundary so we don't
                    // subtract the whole document's worth of
                    // matching substrings.
                    const start = t.lastIndexOf('.', m.index) + 1;
                    const end = t.indexOf('.', m.index + m[0].length);
                    chromeLen += (end > start ? end - m.index : 80);
                }
                if (chromeLen > t.length * 0.4) return;
                const score = t.length - chromeLen;
                if (score > bestScore) { best = t; bestScore = score; }
            });
            return best;
        }""")

        # Trim common Rippling footer text from the captured body
        # ("Powered by Rippling", "Apply now", "Terms of service",
        # etc.). We cut at the first occurrence of these markers.
        if description:
            cut_markers = [
                "Apply now\n",
                "Powered by Rippling",
                "Terms of service",
            ]
            for marker in cut_markers:
                idx = description.find(marker)
                if idx > 200:
                    description = description[:idx]
            description = description.strip() or None

        # Location: Rippling templates list "Remote (United States)"
        # or "<city>" at the bottom of the page. We try to find it
        # after the body — these tokens appear between the body
        # and the "Apply now" CTA.
        location = None
        if description:
            loc_m = _re.search(
                r"\b(Remote(?:\s*\([A-Z][^)]+\))?|\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*,\s*[A-Z]{2})\b(?=\s*Apply now|\Z)",
                description,
            )
            # Simpler: look for "Remote (United States)" pattern
            # near the end of the description.
            remote_m = _re.search(
                r"Remote(?:\s*\([^)]+\))?",
                description[-400:] if len(description) > 400 else description,
            )
            if remote_m:
                location = remote_m.group(0).strip()

        if not title and not description:
            log.info("Rippling: no job DOM rendered for %s", url)
            return None

        return {
            "position_title": title,
            "company_name": company,
            "location": location,
            "description": description,
            "auth_wall": False,
        }
    except PWTimeout:
        log.warning("Rippling render timed out: %s", url)
        return None
    finally:
        try:
            context.close()
        except Exception:
            pass


def _fetch_paylocity(url: str, host: str, _a: str = "", _b: str = "") -> dict | None:
    """Pull structured data from a Paylocity careers page.

    Paylocity exposes two URL shapes for the same job:

        https://recruiting.paylocity.com/Recruiting/Jobs/Apply/<jobId>/<slug>
        https://recruiting.paylocity.com/Recruiting/Jobs/Details/<jobId>

    The Apply variant is the multi-step application form (Step 1 of
    5) and does NOT contain the description. The Details variant is
    the SEO-friendly full posting with title, location, and
    description body all in plain HTML. We rewrite Apply → Details
    before fetching so the user can paste either URL.

    The page is server-rendered (no SPA, no JSON-LD), so we use a
    plain `requests` GET with the default UA — no Playwright needed.
    Paylocity also emits the full description in the
    `og:description` meta tag, which is the easiest and most
    reliable source. We try the inline HTML first (richer text
    with paragraphs/lists) and fall back to the meta tag.

    Fields:

        - Title: `<span class="job-preview-title">…</span>`.
        - Company: the URL slug from the breadcrumb link
          (`.../recruiting/jobs/All/<tenantId>/<company-slug>`).
        - Location: `<div class="preview-location">…</div>`.
        - Description: the `<div>` immediately following
          `<div class="job-listing-header">Description</div>`,
          taken until the next `<div class="job-listing-header">`
          (Requirements, About, Apply, etc.) or the EEO footer.
    """
    # Rewrite Apply URLs to the Details variant so we hit the
    # description page. If the URL is already a Details URL we
    # fetch it as-is.
    job_id = None
    details_url = url
    m = PAYLOCITY_APPLY_PATH.search(url)
    if m:
        job_id = m.group(1)
        details_url = f"https://recruiting.paylocity.com/Recruiting/Jobs/Details/{job_id}"
    else:
        m = PAYLOCITY_DETAILS_PATH.search(url)
        if m:
            job_id = m.group(1)
        else:
            log.info("Paylocity URL did not match Apply or Details pattern: %s", url)
            return None

    log.info("Paylocity fetch: %s -> %s", url, details_url)
    try:
        import requests as _requests
        resp = _requests.get(
            details_url,
            headers={
                "User-Agent": _requests.utils.default_user_agent(),
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            },
            timeout=20,
            allow_redirects=True,
        )
        if resp.status_code >= 400:
            log.info("Paylocity fetch returned HTTP %s for %s", resp.status_code, details_url)
            return None
        html = resp.text
    except Exception as exc:
        log.warning("Paylocity fetch failed: %s", exc)
        return None

    # Title: Paylocity uses a `<span class="job-preview-title">…</span>`
    # for the job title. The browser <title> is
    # "<JobTitle> Job Details | <Company>", so we could parse that
    # too, but the span is more reliable.
    title = None
    title_m = _re.search(
        r"<span[^>]*class=\"[^\"]*job-preview-title[^\"]*\"[^>]*>\s*(?:<[^>]+>\s*)*([^<]+?)(?:\s*</[^>]+>)*\s*</span>",
        html,
        _re.S | _re.I,
    )
    if title_m:
        title = _decode_entities(_re.sub(r"<[^>]+>", "", title_m.group(1)).strip()) or None
    if not title:
        # Fallback: <title> with "Job Details" suffix stripped.
        title_m = _re.search(r"<title>([^<]+)</title>", html, _re.I)
        if title_m:
            raw = _decode_entities(title_m.group(1).strip())
            cleaned = _re.sub(
                r"\s*(?:Job Details|Careers?|Jobs?)\s*\|.*$",
                "",
                raw,
                _re.I,
            ).strip(" |")
            title = cleaned or None

    # Company: the breadcrumb points at
    # `/recruiting/jobs/All/<tenantId>/<company-slug>`. The slug is
    # the human-readable company name with `-` swapped for spaces.
    # We title-case it, but with a small fix-up: common acronyms
    # like "LLC", "Inc", "Ltd", "PC", "LLP" should stay uppercase.
    # Python's `.title()` would lower-case them ("Llc") which is
    # wrong.
    company = None
    bc_m = _re.search(
        r"/recruiting/jobs/All/[a-f0-9-]+/([^/?\"'#]+)",
        html,
        _re.I,
    )
    if bc_m:
        slug = bc_m.group(1).strip()
        words = slug.replace("-", " ").split()
        titled = [w.capitalize() for w in words]
        # Restore common all-caps acronyms that .title() mangled.
        for i, w in enumerate(titled):
            low = words[i].lower()
            if low in ("llc", "llp", "pc", "pllc", "inc", "ltd", "co", "usa", "us", "uk"):
                titled[i] = low.upper()
        company = " ".join(titled)
    if not company:
        # Fallback: <title> split on `|`.
        title_m = _re.search(r"<title>([^<]+)</title>", html, _re.I)
        if title_m:
            parts = [p.strip() for p in title_m.group(1).split("|")]
            if len(parts) >= 2:
                company = _decode_entities(parts[-1]) or None

    # Location: Paylocity puts the location in
    # `<div class="preview-location">Fully Remote</div>`.
    location = None
    loc_m = _re.search(
        r"<div[^>]*class=\"[^\"]*preview-location[^\"]*\"[^>]*>([^<]+)</div>",
        html,
        _re.S | _re.I,
    )
    if loc_m:
        candidate = _decode_entities(loc_m.group(1).strip())
        # The "Fully Remote" / "<City>, <ST>" forms are short. Anything
        # > 80 chars is a false positive (the regex swallowed the whole
        # body).
        if 3 <= len(candidate) <= 80:
            location = candidate

    # Description: prefer the inline HTML block (preserves
    # paragraphs/lists) over the og:description meta tag (which is
    # one flat string). The HTML structure is:
    #
    #   <div class="job-listing-header">Description</div>
    #   <div>...rich HTML body...</div>
    #   <div class="job-listing-header">Requirements</div>
    #
    # We capture from the END of the "Description" header div
    # to the START of the next "job-listing-header" div. The
    # non-greedy `+?` with the lookahead handles any number of
    # intervening sections.
    desc = None
    desc_m = _re.search(
        r"<div[^>]*class=\"[^\"]*job-listing-header[^\"]*\"[^>]*>\s*Description\s*</div>\s*(.*?)(?=<div[^>]*class=\"[^\"]*job-listing-header[^\"]*\"|<a\b[^>]*>\s*Apply\s*</a>|<button\b[^>]*>[^<]*Apply|E-Verify|Privacy Policy)",
        html,
        _re.S | _re.I,
    )
    if desc_m:
        body_html = desc_m.group(1)
        # Strip script/style blocks first.
        body_html = _re.sub(r"<script\b[^>]*>.*?</script>", "", body_html, flags=_re.S | _re.I)
        body_html = _re.sub(r"<style\b[^>]*>.*?</style>", "", body_html, flags=_re.S | _re.I)
        # Replace block closers with newlines so paragraphs survive.
        body_html = _re.sub(r"<(?:/p|/div|/li|/h[1-6]|/tr|/section)\b[^>]*>", "\n", body_html, flags=_re.I)
        body_html = _re.sub(r"<br\s*/?>", "\n", body_html, flags=_re.I)
        # Strip remaining tags.
        text = _re.sub(r"<[^>]+>", " ", body_html)
        text = _decode_entities(text)
        # Collapse whitespace per line and drop empty lines.
        lines = [_re.sub(r"[ \t]+", " ", ln).strip() for ln in text.split("\n")]
        cleaned = "\n".join([ln for ln in lines if ln]).strip()
        if len(cleaned) >= 100:
            desc = cleaned

    # Fallback: og:description meta tag. Paylocity always emits the
    # full description there as a single flat string. Less ideal
    # than the HTML body (no paragraph breaks) but it's a reliable
    # safety net when the inline block is empty or broken.
    if not desc:
        og_m = _re.search(
            r"<meta[^>]+property=[\"']og:description[\"'][^>]+content=[\"']([^\"']+)[\"']",
            html,
            _re.I,
        )
        if og_m:
            raw = _decode_entities(og_m.group(1))
            # og:description is sometimes truncated mid-sentence at
            # a few KB; we don't try to clean it up beyond entity
            # decoding and whitespace collapse.
            lines = [_re.sub(r"[ \t]+", " ", ln).strip() for ln in raw.split("\n")]
            cleaned = "\n".join([ln for ln in lines if ln]).strip()
            if len(cleaned) >= 100:
                desc = cleaned

    if not title and not desc:
        log.info("Paylocity: no title or description extracted for %s", details_url)
        return None

    return {
        "position_title": title,
        "company_name": company,
        "location": location,
        "description": desc,
        "auth_wall": False,
    }


PUBLIC_ATS_PROVIDERS = (
    # (host-substring match, extractor function)
    ("greenhouse.io", _fetch_greenhouse),
    (GH_LEVER_HOST, _fetch_lever),
    (ASHBY_HOST, _fetch_ashby),
    (GEM_HOST, _fetch_gem),
    (ICIMS_HOST, _fetch_icims),
    (JOBVITE_HOST, _fetch_jobvite),
    (SUCCESSFACTORS_HOST, _fetch_successfactors),
    (RIPLING_HOST, _fetch_rippling),
    (PAYLOCITY_HOST, _fetch_paylocity),
)


def fetch_public_ats_data(url: str) -> dict | None:
    """Dispatch to the right public-ATS fetcher based on URL host. Returns
    None if no provider matches or the provider couldn't extract data."""
    host = _host_of(url)
    if not host:
        return None

    # Greenhouse (classic /jobs/<id>, embed?for=&token=, or company ?gh_jid=)
    board_token, job_id, inferred = _parse_greenhouse_url(url, host)
    if board_token and job_id:
        result = _fetch_greenhouse(url, host, board_token, job_id)
        if result:
            return result
        err = (
            f"greenhouse-inferred-job-not-found: board={board_token} job={job_id}"
            if inferred
            else f"greenhouse-job-not-found: board={board_token} job={job_id}"
        )
        return {
            "auth_wall": False,
            "position_title": None,
            "company_name": None,
            "location": None,
            "description": None,
            "error": err,
        }

    # Lever — collapse /apply?utm=... → posting page before API match.
    m = LEVER_PATH.search(url)
    if m:
        company = m.group(1)
        lever_url = _normalise_lever_url(url) or url
        result = _fetch_lever(lever_url, host, company)
        if result:
            return result
        # EU / regional Lever boards often 404 on api.lever.co.
        # Fall through so the posting HTML (no /apply) can be scraped.
        return None

    # Ashby
    m = ASHBY_PATH.search(url)
    if m:
        board = m.group(1)
        posting_id = m.group(2)
        result = _fetch_ashby(url, host, board, posting_id)
        if result:
            return result
        return {
            "auth_wall": False,
            "position_title": None,
            "company_name": None,
            "location": None,
            "description": None,
            "error": f"ashby-job-not-found: board={board} id={posting_id}",
        }

    # Gem careers (jobs.gem.com/<board>/<extId>) — SPA; need GraphQL.
    m = GEM_PATH.search(url)
    if m:
        board_id = m.group(1)
        ext_id = m.group(2)
        if board_id.lower() not in ("api", "static", "assets"):
            result = _fetch_gem(url, host, board_id, ext_id)
            if result:
                return result
            return {
                "auth_wall": False,
                "position_title": None,
                "company_name": None,
                "location": None,
                "description": None,
                "error": f"gem-posting-not-found: board={board_id} id={ext_id}",
            }

    # iCIMS
    if ICIMS_PATH.search(url):
        return _fetch_icims(url, host)

    # Rippling
    if RIPLING_HOST in host:
        return _fetch_rippling(url, host)

    # Paylocity — Apply URL rewrites to Details URL inside the
    # fetcher, so we route on host here.
    if PAYLOCITY_HOST in host:
        return _fetch_paylocity(url, host)

    # JobVite
    if JOBVITE_PATH.search(url):
        return _fetch_jobvite(url, host)

    # SuccessFactors (SAP) — used by Gainwell, Adobe, etc.
    if SUCCESSFACTORS_PATH.search(url):
        return _fetch_successfactors(url, host)

    # Workday, Paycom, ApplyToJob — fall through to the
    # generic renderer (Playwright + schema.org/JobPosting JSON-LD +
    # OG meta tags). These SPAs all carry JSON-LD or OG meta tags that
    # `fetch_generic_page_data` already knows how to parse. We
    # deliberately don't add them as `PUBLIC_ATS_PROVIDERS` here
    # because they're known-good hosts and we want the generic
    # path to take over.

    return None


# -----------------------------------------------------------------------------
# Top-level fetcher — picks LinkedIn or public-ATS depending on the URL
# -----------------------------------------------------------------------------

def fetch_job_data(url: str) -> dict | None:
    """Routes the URL to the right fetcher.

    Returns the standard shape `{position_title, company_name,
    location, description, auth_wall}` or None if no provider
    matched (or the public-ATS provider explicitly returned None
    for an invalid job id). LinkedIn always goes through Playwright;
    public ATS hosts go through the structured provider first, and
    a 404 there is treated as authoritative — we do NOT fall back
    to the generic renderer because the page would just be the
    company index, which would be misleading to store as job data.

    Workday, Paycom, and ApplyToJob serve JSON-LD schema.org/
    JobPosting (or OG meta tags) so we route them directly to the
    generic renderer — they don't have a structured path like
    Greenhouse does, and routing them through `fetch_public_ats_data`
    would always return None.

    SuccessFactors sites live on a wide variety of customer-owned
    domains (e.g. `jobs.gainwelltechnologies.com`) so we route them
    on URL-path shape, not host substring.

    Rippling ATS now has its own Playwright-backed fetcher in
    `PUBLIC_ATS_PROVIDERS` (`_fetch_rippling`); we let the dispatch
    below pick it up via the `PUBLIC_ATS_PROVIDERS` host check
    rather than routing to the generic renderer directly."""
    # SuccessFactors first — host-agnostic. Many customers use their
    # own domain with a SuccessFactors path (`/job/<loc>/<id>/`).
    if SUCCESSFACTORS_PATH.search(url):
        return _fetch_successfactors(url, _host_of(url) or "")
    host = _host_of(url)
    # Company career pages that wrap Greenhouse (?gh_jid= on zoominfo.com, etc.)
    board_token, job_id, inferred = _parse_greenhouse_url(url, host or "")
    if board_token and job_id and "greenhouse.io" not in (host or ""):
        result = _fetch_greenhouse(url, host or "", board_token, job_id)
        if result and len((result.get("description") or "").strip()) >= 80:
            return result
        if not inferred:
            return {
                "auth_wall": False,
                "position_title": None,
                "company_name": None,
                "location": None,
                "description": None,
                "error": f"greenhouse-job-not-found: board={board_token} job={job_id}",
            }
        # Wrong inferred board — fall through to generic HTML.
    if "linkedin.com" in host:
        return fetch_linkedin_job_data(url)
    # Lever /apply is form-only; JD lives on the posting page.
    if "lever.co" in host:
        normalised_lever = _normalise_lever_url(url)
        if normalised_lever:
            url = normalised_lever
            host = _host_of(url)
    # SPAs with schema.org/OG but no structured path: send them
    # straight to the generic renderer (JSON-LD + OG + Playwright).
    if (
        "myworkdayjobs.com" in host
        or "paycomonline.net" in host
        or "applytojob.com" in host
    ):
        # Workday URLs are first canonicalised — tracking params
        # (spm=, jr_id=, source=jobright, ...) confuse the SPA
        # router and occasionally produce an empty/stripped job
        # body. We strip them here and also validate the path
        # shape so non-job URLs (tenant home, search results) get
        # rejected with a clear "not a job URL" error rather than
        # silently storing the company career-portal index.
        if "myworkdayjobs.com" in host:
            normalised = _normalise_workday_url(url)
            if normalised is None:
                # URL doesn't look like a Workday job. Surface a
                # structured error so the Node cron can record an
                # accurate fetch_error rather than a 404.
                return {
                    "auth_wall": False,
                    "position_title": None,
                    "company_name": None,
                    "location": None,
                    "description": None,
                    "error": "not-a-workday-job-url",
                }
            url = normalised
        return _generic_or_empty_error(url)
    if any(token in host for token, _ in PUBLIC_ATS_PROVIDERS):
        # Prefer the structured public API for known ATS hosts.
        # Greenhouse / Lever / Ashby 404s are authoritative — do NOT
        # fall through to generic HTML (board indexes look like jobs).
        structured = fetch_public_ats_data(url)
        if structured and structured.get("error"):
            return structured
        if structured and len((structured.get("description") or "").strip()) >= 80:
            return structured

        host_l = host.lower()
        definitive_api_hosts = (
            "greenhouse.io",
            "lever.co",
            "ashbyhq.com",
            "jobs.gem.com",
        )
        if any(h in host_l for h in definitive_api_hosts):
            return {
                "auth_wall": False,
                "position_title": None,
                "company_name": None,
                "location": None,
                "description": None,
                "error": "job-not-found-or-empty",
            }

        log.info(
            "structured ATS miss for %s — falling back to generic renderer",
            url,
        )
        return _generic_or_empty_error(url)
    # Anything else: try the generic Playwright renderer.
    return _generic_or_empty_error(url)


def _generic_or_empty_error(url: str) -> dict:
    """Run the generic renderer; convert empty/thin results into an
    error so Node marks the row failed instead of success-with-empty-JD
    (or worse: storing a board index title like 'All Jobs')."""
    generic = fetch_generic_page_data(url)
    if generic.get("error") or generic.get("auth_wall"):
        return generic
    desc = (generic.get("description") or "").strip()
    # Require a real body — a title alone is not enough (board indexes
    # and marketing pages often have an <h1> with no job content).
    if len(desc) >= 80:
        return generic
    return {
        "auth_wall": False,
        "position_title": None,
        "company_name": None,
        "location": None,
        "description": None,
        "error": "job-not-found-or-empty",
    }


def fetch_generic_page_data(url: str) -> dict:
    """Generic Playwright renderer. Tries JSON-LD first (covers
    virtually every modern job board via schema.org/JobPosting),
    falls back to OG meta tags + the first <h1> for the title."""
    log.info("generic-rendering %s", url)
    browser = _start_browser()
    context = browser.new_context(
        user_agent=USER_AGENT,
        viewport={"width": 1280, "height": 800},
    )
    page = context.new_page()
    try:
        # NOTE on `wait_until`: we deliberately use
        # `domcontentloaded` instead of `networkidle` because many
        # public ATS sites (Ultipro, ApplyToJob, iCIMS, etc.) keep
        # advertising / analytics / websocket connections open
        # indefinitely, which means `networkidle` never fires
        # within our 30s budget and the page gets marked as a
        # timeout. `domcontentloaded` fires as soon as the HTML
        # document is parsed; we then wait an extra hydration
        # window below so React/Next renderers can populate the
        # body.
        page.goto(url, wait_until="domcontentloaded", timeout=30_000)
        # Wait for SPA hydration. Many ATS pages (Next.js / React)
        # ship an OG-only skeleton on first paint and inject the
        # real job body once React mounts. 3s covers the median
        # hydration window; the OG fallback below covers the cases
        # where hydration hasn't completed by then.
        page.wait_for_timeout(3000)

        # Try schema.org/JobPosting first.
        title = company = location = description = None
        try:
            lds = page.eval_on_selector_all(
                "script[type='application/ld+json']",
                "els => els.map(e => e.textContent)"
            )
            for raw in lds:
                try:
                    j = json.loads(raw)
                except Exception:
                    continue
                candidates = [j]
                if isinstance(j, dict) and isinstance(j.get("@graph"), list):
                    candidates.extend(j["@graph"])
                for c in candidates:
                    if not isinstance(c, dict):
                        continue
                    if c.get("@type") == "JobPosting":
                        org = c.get("hiringOrganization") or {}
                        loc = (
                            c.get("jobLocation")
                            and c["jobLocation"].get("address")
                            or {}
                        )
                        loc_parts = [
                            loc.get("addressLocality"),
                            loc.get("addressRegion"),
                            loc.get("addressCountry"),
                        ]
                        title = title or c.get("title")
                        company = company or (org.get("name") if isinstance(org, dict) else None)
                        location = location or ", ".join([x for x in loc_parts if x])
                        description = description or _strip_html(c.get("description") or "")
                        break
        except Exception as exc:
            log.debug("JSON-LD walk failed: %s", exc)

        # If JSON-LD didn't give us a description (or only a short
        # truncated one — many sites put an SEO snippet in
        # schema.org and the full body lives in the rendered
        # DOM), fall back to walking the rendered page and
        # picking the longest innerText block that looks like
        # job-body content. We try <main> / <article> first
        # (the most common wrappers), then fall back to a global
        # walk similar to the Rippling renderer.
        if not description or len(description) < 400:
            try:
                candidates = page.evaluate("""() => {
                    const out = [];
                    // 1. The semantic <main>/<article> wrappers.
                    //    A score penalty is applied to <main>
                    //    elements that ALSO contain a <form> AND
                    //    are clearly the page wrapper (the
                    //    score is reduced by the length of any
                    //    form + nav + footer-like paragraphs
                    //    found inside). This handles thatch.com-
                    //    style pages where the first <main> is
                    //    the whole page wrapper (nav + job post
                    //    + form + footer), and the actual job
                    //    body is a sibling <div> further down.
                    const FORM_HINT = /Apply for this position|Apply for the|Submit Application|Submit your application|Legal First Name|Last Name\\*|Resume\\/CV\\*|Cover Letter|How many years|Voluntary Self|Equal Employment Opportunity|Equal Opportunity Employer|Demographic/i;
                    document.querySelectorAll('main, article, [role=main]').forEach(el => {
                        const t = (el.innerText || '').trim();
                        if (!t) return;
                        // Verify this <main> isn't a giant wrapper
                        // around a form + footer. If it contains
                        // a <form> AND a known form/footer marker,
                        // give it a heavy score penalty so the
                        // cleaner inner div wins.
                        let penalty = 0;
                        if (el.querySelector('form') && FORM_HINT.test(t)) {
                            penalty = 3000;
                        }
                        out.push({text: t, score: t.length - penalty});
                    });
                    // 2. Common job-body class names (Workday,
                    // Phenom, Greenhouse-style WordPress, etc.)
                    //    Also covers thatch.com's `class="job-post"`.
                    const sel = [
                        '[class*="job-description" i]',
                        '[class*="jobDescription" i]',
                        '[class*="description" i]',
                        '[class*="job-body" i]',
                        '[class*="jobBody" i]',
                        '[class*="job-post" i]',
                        '[class*="jobPost" i]',
                        '[class*="posting" i]',
                        '[id*="job-description" i]',
                        '[data-testid*="job-description" i]',
                    ].join(',');
                    document.querySelectorAll(sel).forEach(el => {
                        const t = (el.innerText || '').trim();
                        if (!t) return;
                        let penalty = 0;
                        if (el.querySelector('form') && FORM_HINT.test(t)) {
                            penalty = 3000;
                        }
                        out.push({text: t, score: (t.length - penalty) * 1.4});
                    });
                    // 3. Global walk — pick the longest <div>/
                    // <section>/<article> innerText block that
                    // doesn't look like a nav/footer. This is the
                    // last-resort path for SPAs that don't use
                    // semantic wrappers.
                    const FOOTER_HINT = /Terms of service|Privacy|Cookie|All rights reserved|Powered by|Apply now/i;
                    document.querySelectorAll('div, section, article').forEach(el => {
                        const t = (el.innerText || '').trim();
                        if (t.length < 500) return;
                        if (FOOTER_HINT.test(t)) return;
                        let penalty = 0;
                        if (el.querySelector('form') && FORM_HINT.test(t)) {
                            penalty = 3000;
                        }
                        out.push({text: t, score: t.length - penalty});
                    });
                    // Sort by score desc, dedupe by text prefix.
                    out.sort((a, b) => b.score - a.score);
                    const seen = new Set();
                    return out.filter(o => {
                        const key = o.text.slice(0, 120);
                        if (seen.has(key)) return false;
                        seen.add(key);
                        return true;
                    });
                }""")
                # Walk candidates, pick the first that is longer
                # than what we already have (or any candidate if
                # JSON-LD gave us nothing).
                for c in (candidates or []):
                    txt = (c.get("text") or "").strip()
                    if not txt:
                        continue
                    if description and len(txt) <= len(description):
                        continue
                    # Trim obvious footer / CTA noise that the
                    # global walk can pick up. We use two lists:
                    #   PLAIN — exact substrings that are always
                    #     footer/CTA noise at any position
                    #   FOOTER_ONLY — markers that ONLY count at
                    #     the very end of the text (last 600 chars)
                    #     because the same words can appear in
                    #     legitimate body content (e.g. Filevine's
                    #     own product copy mentions "Powered by
                    #     LOIS" mid-description, which is body
                    #     content, not a footer).
                    PLAIN = [
                        # CTA / application-form starters — anything
                        # after these markers is the application's
                        # form, not the job description.
                        "Apply now",
                        "Apply Now",
                        "Apply for this position",
                        "Apply for this role",
                        "Apply for this job",
                        "Apply for the position",
                        "Apply for the role",
                        "Apply for the job",
                        "Submit Application",
                        "Submit application",
                        "Submit your application",
                        "Submit Your Application",
                        "Begin application",
                        "Start application",
                        # Footer / legal text
                        "Terms of service",
                        "Terms of Service",
                        "Terms of use",
                        "Privacy policy",
                        "Cookie policy",
                        "Cookie Preferences",
                        "Cookie Settings",
                        "Equal Opportunity Employer",
                        "Equal Employment Opportunity",
                        "Voluntary Self-Identification",
                        # Plumbing the trim through older templates
                        "Read more",
                        "Show more",
                        "Read less",
                    ]
                    FOOTER_ONLY = [
                        # Bare "Powered by" is too aggressive — many
                        # products / brands describe themselves with
                        # "Powered by <X>" mid-copy. Only count it
                        # as a footer marker when it appears in the
                        # tail of the text, where the global walk
                        # picks up the site footer.
                        "Powered by ",
                        # Privacy Policy / Notice variants — body
                        # content sometimes says "see our Privacy
                        # Policy" mid-doc, but the FOOTER_HINT in
                        # the global walk already filters those
                        # whole blocks. Belt-and-suspenders here.
                    ]
                    # Head-trim: drop top nav / sign-in bar / etc.
                    # when the first ~400 chars are obviously nav.
                    # We use the page's H1 as the anchor — start
                    # the description at the H1 if we can find it.
                    try:
                        h1_text = page.evaluate(
                            "() => {"
                            "  const h = document.querySelector('h1');"
                            "  return h ? (h.innerText || '').trim() : null;"
                            "}"
                        )
                        if h1_text and len(h1_text) >= 4:
                            head_idx = txt.find(h1_text)
                            if 50 < head_idx < 1500:
                                txt = txt[head_idx:]
                    except Exception:
                        pass
                    for marker in PLAIN:
                        idx = txt.find(marker)
                        if idx > 200:
                            txt = txt[:idx]
                    # Footer-only markers only fire in the last
                    # 600 chars so we don't chop mid-description.
                    tail = txt[-600:] if len(txt) > 600 else txt
                    for marker in FOOTER_ONLY:
                        idx = tail.find(marker)
                        if idx > 200:
                            # idx is relative to tail; convert to
                            # absolute position in txt.
                            abs_idx = (len(txt) - len(tail)) + idx
                            txt = txt[:abs_idx]
                    # Trim any leading nav cluster that survived —
                    # short single-word or short-phrase lines that
                    # appear before the H1-anchored header lines
                    # (e.g. "THATCH\nHow it works\n..." before
                    # "Software Engineer: Backend at Thatch").
                    # If the first newline-separated chunk is
                    # shorter than 40 chars AND there are ≥3 such
                    # chunks before the first ≥30-char chunk,
                    # strip them.
                    first_lines = txt.split("\n", 8)
                    drop_until = 0
                    seen_long = False
                    for i, ln in enumerate(first_lines):
                        if len(ln.strip()) >= 30:
                            seen_long = True
                            drop_until = i
                            break
                        if len(ln.strip()) == 0:
                            continue
                        drop_until = i + 1
                        # Don't drop more than 6 lines of nav.
                        if drop_until > 6:
                            break
                    if seen_long and drop_until >= 2:
                        txt = "\n".join(first_lines[drop_until:])
                    txt = _strip_html(txt).strip()
                    if txt and len(txt) > len(description or ""):
                        description = txt
                        break
            except Exception as exc:
                log.debug("description walk failed: %s", exc)

        # Fallback: title from <h1> or og:title; description from
        # og:description. These are SEO snippets and are often
        # shorter than the real body, but they're better than
        # nothing.
        if not title:
            try:
                h1 = page.query_selector("h1")
                og = page.query_selector("meta[property='og:title']")
                title = (h1.inner_text() if h1 else None) or (
                    og.get_attribute("content") if og else None
                )
            except Exception:
                pass
        if not description:
            try:
                ogd = page.query_selector("meta[property='og:description']")
                description = ogd.get_attribute("content") if ogd else None
            except Exception:
                pass

        # Last-resort company_name fallback: derive from the
        # URL's registered domain when JSON-LD / OG don't carry
        # one. Skip generic suffixes (www, careers, jobs, apply,
        # boards, ashbyhq, lever, greenhouse) and title-case the
        # rest. e.g. `www.filevine.com` → "Filevine",
        # `careers.acme.com` → "Acme", `ats.rippling.com/foo/...`
        # → "Foo".
        if not company:
            try:
                from urllib.parse import urlparse as _up
                host = (_up(url).hostname or "").lower()
                # Strip leading "www.", "careers.", "jobs.",
                # "apply.", "boards." subdomains that are pure
                # ATS-naming and don't represent the company.
                bare = host
                for prefix in ("www.", "careers.", "jobs.", "apply.", "boards."):
                    if bare.startswith(prefix):
                        bare = bare[len(prefix):]
                # Labels that are generic TLDs or pure ATS infra
                # rather than company names. Used to walk inward
                # through the hostname until we find a usable slug.
                TLD_SKIP = {"com", "co", "io", "ai", "net", "org", "app", "dev", "us", "uk"}
                ATS_SKIP = {
                    "ashbyhq", "lever", "greenhouse", "linkedin",
                    "myworkdayjobs", "icims", "jobvite", "successfactors",
                    "paycom", "applytojob", "rippling", "paylocity",
                    "wd1", "wd2", "wd3", "wd4", "wd5", "wd6", "wd7", "wd8",
                }
                parts = bare.split(".")
                if len(parts) >= 2:
                    # Walk inward from the second-to-last label
                    # toward the front, skipping TLDs and ATS slugs.
                    # Examples:
                    #   circle.wd1.myworkdayjobs.com → "Circle"
                    #   emcins.wd5.myworkdayjobs.com → "Emcins"
                    #   www.filevine.com             → "Filevine"
                    slug = None
                    for candidate in reversed(parts[:-1]):
                        if candidate in TLD_SKIP or candidate in ATS_SKIP:
                            continue
                        slug = candidate
                        break
                    if slug:
                        company = slug.replace("-", " ").title()
                # Workday URLs also expose the tenant in the path's
                # first segment: `<host>/<Tenant>/job/...`. When the
                # hostname walk above landed on something like
                # "Wd1" (rare but possible) or returned nothing,
                # the path is the more authoritative source.
                if not company and "myworkdayjobs.com" in host:
                    path_parts = [
                        p for p in (_up(url).path or "").split("/")
                        if p
                    ]
                    if path_parts:
                        tenant = path_parts[0]
                        if tenant.lower() not in {"job", "jobs", "search", "en-us", "en-gb"}:
                            company = tenant.replace("-", " ").title()
            except Exception:
                pass

        return {
            "position_title": (title or "").strip() or None,
            "company_name": (company or "").strip() or None,
            "location": (location or "").strip() or None,
            "description": (description or "").strip() or None,
            "auth_wall": False,
        }
    except PWTimeout as exc:
        log.warning("playwright timeout for %s: %s", url, exc)
        _restart_browser()
        raise
    except Exception as exc:
        log.exception("generic render failed: %s", url, exc)
        _restart_browser()
        raise
    finally:
        try:
            context.close()
        except Exception:
            pass


# -----------------------------------------------------------------------------
# Rate-limited worker
# -----------------------------------------------------------------------------

_rate_lock = threading.Lock()
_last_scrape_at: float = 0.0


def _throttle() -> None:
    """Sleep until at least SCRAPE_INTERVAL_MS has passed since the
    last scrape. Defense-in-depth on top of whatever throttling the
    Node cron applies."""
    global _last_scrape_at
    with _rate_lock:
        now = time.monotonic()
        elapsed_ms = (now - _last_scrape_at) * 1000.0
        wait_ms = max(0.0, SCRAPE_INTERVAL_MS - elapsed_ms)
        if wait_ms > 0:
            time.sleep(wait_ms / 1000.0)
        _last_scrape_at = time.monotonic()


# -----------------------------------------------------------------------------
# Flask app
# -----------------------------------------------------------------------------

app = Flask(__name__)


@app.get("/health")
def health() -> Any:
    return jsonify({
        "status": "ok",
        "auth": "cookie" if LI_AT_COOKIE else "anonymous",
        # Expose (truncated) length, never the value, so health doesn't
        # leak the cookie over plaintext if a process is monitored.
        "cookie_present": bool(LI_AT_COOKIE),
        "rate_limit_ms": SCRAPE_INTERVAL_MS,
    }), 200


@app.post("/scrape")
def scrape() -> Any:
    body = request.get_json(silent=True) or {}
    url = (body.get("url") or "").strip()
    if not url:
        return jsonify({"error": "url is required"}), 400

    # Validate the URL — accept any public ATS we know how to scrape:
    # LinkedIn (with optional auth cookie), Greenhouse (boards +
    # job-boards subdomains), Lever. Anything else gets a 400 so
    # typos surface immediately rather than spinning on a dead URL.
    parsed = _urlparse.urlparse(url)
    host = (parsed.hostname or "").lower()
    if not host:
        return jsonify({"error": "url must be an absolute http(s) URL"}), 400
    # SSRF guard: refuse obvious local/private targets. The Node
    # layer also checks this, but defence-in-depth is cheap.
    if (
        host == "localhost"
        or host.endswith(".localhost")
        or host.endswith(".local")
        or host.endswith(".internal")
        or host.startswith("127.")
        or host.startswith("10.")
        or host.startswith("192.168.")
        or host.startswith("169.254.")
        or host.startswith("0.")
    ):
        return jsonify({
            "error": "url host is private/local — refusing to forward to the generic renderer",
            "host": host,
        }), 400

    # We accept any well-formed public http(s) URL. The dedicated
    # ATS extractors (Greenhouse / Lever / Ashby / iCIMS / JobVite
    # / SuccessFactors / Rippling / Paylocity) match on host
    # substrings below; the SuccessFactors path-based matcher also
    # catches customer-owned SF domains. Everything else falls
    # through to the generic Playwright renderer (JSON-LD + OG
    # + DOM walk), which is what handles filevine.com, kzen.ai,
    # blizzard careers portals, nlsnow, etc.
    has_structured = (
        "linkedin.com" in host
        or "greenhouse.io" in host
        or "lever.co" in host
        or "ashbyhq.com" in host
        or "jobs.gem.com" in host
        or "icims.com" in host
        or "jobvite.com" in host
        or "myworkdayjobs.com" in host
        or "successfactors.com" in host
        or "paycomonline.net" in host
        or "applytojob.com" in host
        or "ats.rippling.com" in host
        or "recruiting.paylocity.com" in host
        or bool(SUCCESSFACTORS_PATH.search(url))
    )
    log.info(
        "scrape request url=%s host=%s has_structured=%s",
        url, host, has_structured
    )

    _throttle()
    try:
        data = fetch_job_data(url)
    except Exception as exc:
        return jsonify({"error": str(exc) or "scrape failed"}), 502
    if data is None:
        # Most common cause: a Greenhouse URL with an invalid job id.
        # The provider returns None instead of a dict so we can tell
        # "the URL parsed but the resource is gone" apart from
        # "the host isn't supported".
        return jsonify({
            "error": "job-not-found",
            "message": "The URL parsed but no provider could return job data. Most often this means the job ID is invalid (LinkedIn retired / Greenhouse 404). Check the URL in the row.",
            "url": url,
        }), 404

    # If LinkedIn returns the auth wall, surface a useful message in
    # the response body so the Node side can record a real
    # fetch_error instead of meaningless "Not Found" data.
    if data.get("auth_wall"):
        return jsonify({
            **data,
            "error": "linkedin-auth-wall",
            "message": (
                "LinkedIn served the sign-in wall. Set the LINKEDIN_LI_AT env "
                "var with a valid li_at cookie to fetch authenticated pages."
            ),
        }), 200

    return jsonify(data), 200


@app.errorhandler(404)
def _not_found(_exc):
    return jsonify({"error": "not found"}), 404


if __name__ == "__main__":
    auth_mode = "cookie" if LI_AT_COOKIE else "anonymous (no LINKEDIN_LI_AT set — LinkedIn auth-wall expected)"
    log.info(
        "starting on %s:%d (rate cap %dms between scrapes, auth=%s)",
        HOST, PORT, SCRAPE_INTERVAL_MS, auth_mode
    )
    if not LI_AT_COOKIE:
        log.warning(
            "LINKEDIN_LI_AT is not set — most LinkedIn pages will return "
            "the sign-in wall. To fetch authenticated pages, set "
            "LINKEDIN_LI_AT in server/.env with a valid session cookie."
        )
    # Single-threaded server — our rate-limit logic assumes scrapes
    # run serially. Don't bump `threaded=True`.
    app.run(host=HOST, port=PORT, threaded=False, use_reloader=False)
