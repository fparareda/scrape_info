# US Scraping Preflight — 2026-06-09

## Objective
Find ONE new scrapeable source for the US fitting existing taxonomy categories.
Gap analysis: `fiscal` (CPAs) had no coverage; all contractor/healthcare categories well-covered.

## Candidates Evaluated

### ✅ PICKED: WA Board of Accountancy — wa-cpa-board

| Field | Value |
|---|---|
| URL | https://data.wa.gov/Consumer-Protection/Washington-State-Certified-Public-Accountants/6du3-3h9e |
| Socrata API | https://data.wa.gov/resource/6du3-3h9e.json |
| Category | `fiscal` |
| Records | ~50,775 total; ~25–30k active (nightly upstream refresh) |
| Robots | Allowed (Socrata open-data, no restrictions) |
| Rendering | JSON API (Socrata `$limit`/`$offset` pagination) |
| Auth | None |
| Cloudflare | No |
| Fields | firstname, lastname, city, country, number, status, originalissue, expires |

**Status:** Implemented → `src/sources/wa-cpa-board.ts`. First US source for `fiscal` CategoryKey.

### ❌ BLOCKED: NASBA CPAverify / Accountancy Licensee Database (ALD)

| Field | Value |
|---|---|
| URL | https://ald.nasba.org/search/cpa |
| Category | `fiscal` |
| Records | ~660,000 active CPAs nationwide |
| Robots | Disallows `/api/*`, `/ald-search/*` |
| ToS | Explicit prohibition on bots/scrapers/crawlers |

**Status:** Blocked. ToS and robots.txt both prohibit automated access. Do not use.

## Implemented

- Source slug: `wa-cpa-board`
- ScrapeSource enum: `"wa-cpa-board"` added to `src/types.ts`
- Runner env: `PROLIO_RUN_WA_CPA_BOARD` / `PROLIO_WA_CPA_BOARD_LIMIT`
- Cron: monthly (5th of month, 04:00 UTC)
- Workflow: `.github/workflows/scrape-wa-cpa-board.yml`
