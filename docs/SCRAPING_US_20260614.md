# US Scraping Pre-flight — 2026-06-14

Agent: solo US expansion agent  
Date: 2026-06-14  
Outcome: **implemented** — `irs-ea-foia` (CategoryKey: `fiscal`)

---

## Candidates Evaluated

### 1. NCARB — National Council of Architectural Registration Boards (arquitecto)

- **URL checked**: https://www.ncarb.org/ncarb-certificate/benefits/lookup  
  and https://www.ncarb.org/get-licensed/state-licensing-boards/architect-lookup
- **robots.txt**: https://www.ncarb.org/robots.txt — no Disallow for the lookup path.
- **Interface**: The NCARB certificate lookup is a JavaScript SPA (Drupal + React
  front-end) — the form renders in the browser but no REST/GraphQL endpoint is visible
  in the server-rendered HTML. No JSON API surface found.
- **State-by-state redirect**: The "Architect License Lookup" page links to
  `https://my.ncarb.org/apps/license-verification/[STATE]` but these redirect to each
  individual state licensing board website (e.g. CA → search.dca.ca.gov). CA DCA is
  already covered by `ca-dca-open-data`. Iterating all 55 states would require
  per-board adapters, which is a separate multi-PR effort.
- **Verdict**: SKIPPED — no bulk-accessible endpoint; state-board redirects already
  partially covered.

### 2. AIA — American Institute of Architects (arquitecto)

- **URLs checked**: https://www.aia.org/find-an-architect and /find-a-firm  
- **robots.txt**: https://www.aia.org/robots.txt — no Disallow for these paths, but
  both URLs returned HTTP 404 (the AIA member directory was retired/moved).
- **Verdict**: SKIPPED — 404.

### 3. NASBA CPAverify (fiscal — licensed CPAs)

- **URL checked**: https://app.cpaverify.org/search (redirects to https://ald.nasba.org/search/cpa)
- **robots.txt**: https://ald.nasba.org/robots.txt  
  ```
  Disallow: /api/*
  ```
  The API path is explicitly disallowed.
- **Interface**: Requires Last Name + Jurisdiction (both mandatory). No bulk export.
  The `/api/*` Disallow blocks any REST endpoint scraping.
- **Verdict**: SKIPPED — robots.txt Disallows /api/*; no bulk download.

### 4. IRS FOIA — Active Enrolled Agents (fiscal) ✅ SELECTED

- **URL**: https://www.irs.gov/tax-professionals/enrolled-agents/active-enrolled-agents-and-the-freedom-of-information-act
- **File**: `https://www.irs.gov/pub/foia/active-ea-foia-listing-<month>-<year>.csv`
- **robots.txt**: https://www.irs.gov/robots.txt — no Disallow for `/pub/` or
  `/tax-professionals/` paths. The FOIA CSV is intentionally public per federal law.
- **Format**: CSV, server-generated (no JS required), ~several MB.
- **Columns**: First Name, Middle Name, Last Name, Address Line 1, Address Line 2,
  Address Line 3, City, State, Country, Zip (plus empty trailing columns).
- **Record count**: ~87,000 active enrolled agents worldwide; majority US-based
  (~70,000 estimated after filtering to Country=US + valid US city slug).
- **Auth/CAPTCHA/rate-limit**: None — pure HTTP GET, no session, no token.
- **Update cadence**: Bi-annual (typically May and November).
- **CategoryKey**: `fiscal` — Enrolled Agents are federally licensed tax
  professionals authorized to represent taxpayers before the IRS. Closest US
  equivalent to "asesor fiscal" in ES taxonomy.
- **Stable URL issue**: Filename encodes month/year; we probe 7 rolling-window
  candidate URLs and fall back to `PROLIO_IRS_EA_FOIA_URL` env override.
- **Verdict**: VIABLE — implemented as `irs-ea-foia`.

### 5. IRS Enrolled Agent EAIN Search (fiscal)

- **URL**: https://apps.irs.gov/app/eain/search.html
- **Status**: HTTP 302 → /404. The EAIN search was decommissioned.
- **Verdict**: SKIPPED — URL gone.

---

## Implementation

- Source file: `src/sources/irs-ea-foia-us.ts`
- Source name in ScrapeSource union: `"irs-ea-foia"` (src/types.ts)
- Enabled flag: `PROLIO_RUN_IRS_EA_FOIA=true`
- Limit flag: `PROLIO_IRS_EA_FOIA_LIMIT` (default 100,000)
- Workflow: `.github/workflows/scrape-irs-ea-foia.yml` — monthly 1st at 06:00 UTC
- Env in runner: `_scrape-runner.yml` (PROLIO_RUN_IRS_EA_FOIA line added)
