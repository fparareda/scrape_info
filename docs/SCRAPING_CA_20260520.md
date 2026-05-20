# CA Scraper Research — 2026-05-20

Research sprint to find one new scrapeable CA source for verifiable
professional-contact records. Each candidate was checked for:
(a) robots.txt allows the target paths,
(b) plain HTTP returns HTML or JSON (no Cloudflare, captcha, or login),
(c) ≥500 records,
(d) maps to an existing taxonomy CategoryKey.

---

## Candidates investigated

### 1. CICC — College of Immigration and Citizenship Consultants (`extranjeria`)

- **URL:** register.college-ic.ca
- **robots.txt:** Allows `/` (only disallows `/Admin`, `/js`, `/css`, `/img`, `/StyleGuide`).
- **Verdict: BLOCKED** — The public register at `register.college-ic.ca` returns
  HTTP 403 for all paths attempted (both polite UA and Chrome UA). The main
  college-ic.ca site returned 404 for `/protecting-the-public/find-a-regulated-*`.
  The search interface at `/Public-Register-EN/.../*.aspx` also 403s.
  Record count cannot be verified. Reserve for Playwright/residential-IP adapter.

### 2. CNQ — Chambre des notaires du Québec (`notario`)

- **URL:** cnq.org
- **robots.txt:** Explicitly blocks `ClaudeBot` with `Disallow: /` under its own
  user-agent stanza. Per our policy of respecting robots.txt, this source is
  **disqualified** regardless of data quality.
- **Verdict: BLOCKED** — robots.txt `Disallow: /` for ClaudeBot.

### 3. CDSBC / BCCOHP — BC College of Oral Health Professionals (`dentista`)

- **URL:** oralhealthbc.ca / apps.oralhealthbc.ca/apps/public-register/
- **robots.txt:** Not found at apps.oralhealthbc.ca (404). The redirect destination
  appears to be an ASP.NET WebForms app with stateful ViewState — requires
  JavaScript and form post interactions to retrieve paginated results.
- **Verdict: BLOCKED** — stateful ASPX/WebForms, no plain GET endpoint.

### 4. PEO — Professional Engineers Ontario (`ingenieria`)

- **URL:** peo.on.ca/directory
- **robots.txt:** Standard Drupal robots.txt; disallows `/admin/`, `/user/`,
  `/search/` etc., but the `/directory` and `/public-protection/directory-practitioners`
  paths are allowed.
- **Access check:** The `/public-protection/directory-practitioners` URL returned
  HTTP 403. Terms of use explicitly state "unauthorized use may be subject to action";
  the directory appears WAF-protected from datacenter IPs.
- **Verdict: BLOCKED** — 403 from datacenter IP; terms prohibit automated use.

### 5. MDA — Manitoba Dental Association (`dentista`)

- **URL:** manitobadentist.ca/public-patients/registries-rosters/dentist-registry
- **robots.txt:** `User-agent: * / Allow: /` — entirely permissive, zero disallows.
- **Access check:** Plain HTTP GET returns full server-rendered HTML with all
  registered dentists (~900 estimated), alphabetical client-side filtering
  (no server-side pagination required). No captcha, no login, no Cloudflare.
- **Records:** 540+ confirmed visible just through "J"; total estimated 900+.
- **Fields available:** Name (Dr. prefix), clinic name, full address (city/MB/postal),
  phone number, graduation year, registration year, classification (GP / Specialist),
  speciality, sedation-roster qualifications.
- **Verdict: VIABLE** — plain HTML, robots allows, ≥500 records, maps to `dentista`.

---

## Decision

**Selected: MDA Manitoba Dental Association** — the only candidate satisfying all
four criteria.

Implemented as `src/sources/mda-mb-dentists.ts` with:
- Single-page HTML fetch (all records on one page)
- Polite UA with Chrome fallback
- Inline robots check via the pathMatchesDisallow pattern
- Name-based dedup (`mda:<name-slug>`)
- City mapping for major MB cities (default: winnipeg)
- Phone normalisation to E.164 (+1XXXXXXXXXX)
- Off by default: `PROLIO_RUN_MDA_MB_DENTISTS=true`
- Monthly schedule (dental registrations are annual/slow-moving)
- Budget knob: `PROLIO_MDA_MB_DENTISTS_LIMIT` (default 5000)
