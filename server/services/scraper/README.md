# Job-link scraper service

The job_links directory on the admin dashboard lists every job the
team is tracking. Each row carries a LinkedIn job URL whose full
description is meant to be fetched in the background so the user
never waits on a slow LinkedIn response.

Two backends are available:

- **`pythonService`** — a small Flask app that drives Playwright
  Chromium (`services/scraper/python_service.py`). This is preferred
  because Playwright's stealth is the most reliable way to bypass
  LinkedIn's bot wall.
- **`nodeBuiltin`** — a fallback that runs in-process using the
  project's existing `puppeteer-core` and `cheerio` deps. Used
  whenever the Python service is unreachable.

The Node side (`services/jobLinkScraper.js`) picks one of the two
based on the `JOB_LINKS_SCRAPER_PROVIDER` env var (`auto`,
`python`, or `node`) and probes the Python service when `auto`.

## Install the Python service

The Python service needs:

- Python 3.9 or newer
- `flask` (`pip install flask`)
- `playwright` (`pip install playwright`) plus its headless
  Chromium (`playwright install chromium`)

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install flask playwright
playwright install chromium
```

If you don't have `pip` (some Debian / Ubuntu installs omit
`ensurepip`), bootstrap it with:

```bash
curl -sSL https://bootstrap.pypa.io/get-pip.py | python3 - --user
```

## Run

```bash
python3 services/scraper/python_service.py
# listens on 127.0.0.1:8765 by default
```

Override with env vars if needed:

```bash
HOST=0.0.0.0 PORT=9000 python3 services/scraper/python_service.py
```

Probe it:

```bash
curl http://127.0.0.1:8765/health
# {"status":"ok"}

curl -X POST http://127.0.0.1:8765/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.linkedin.com/jobs/view/4451489840"}'
```

The response carries `position_title`, `company_name`, `location`,
`description`. Errors come back as 4xx / 5xx with a JSON `error`
field.

## Point the Node cron at it

The Node side defaults to `http://127.0.0.1:8765`. Override with:

```bash
JOB_LINKS_SCRAPER_URL=http://10.0.0.5:9000 \
  JOB_LINKS_SCRAPER_PROVIDER=python \
  npm start
```

Set `JOB_LINKS_SCRAPER_PROVIDER=node` to skip the Python service
entirely (the cron falls back to the in-process scraper).
