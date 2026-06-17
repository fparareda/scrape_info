# US Scraper Pre-flight — 2026-05-13

## Candidates Evaluated

### 1. South Carolina LLR (SC contractors)
- URL: https://verify.llronline.com/LicLookup/LookupMain.aspx
- robots.txt: 404 (no robots.txt file found)
- Data access: Individual lookup only via ASPX form — no bulk CSV or API found
- Record count: Unknown
- Verdict: **blocked / insufficient** — no bulk export; ASPX form with session state

### 2. IRS Enrolled Agents (fiscal)
- URL: https://www.irs.gov/tax-professionals/find-a-tax-professional
- robots.txt: https://www.irs.gov/robots.txt — Disallows /search/ and /*search=*
- Data access: RPO bulk zip (https://www.irs.gov/pub/irs-utl/RPO_Database.zip) returned 404
- Record count: Unknown
- Verdict: **blocked** — search paths disallowed by robots.txt; no accessible bulk download confirmed

### 3. Bureau of Automotive Repair California (BAR) — mecanica
- URL: https://www.bar.ca.gov
- robots.txt: Disallows /locator? and /locator/ (the shop finder) and /enforcement?
- Data access: DCA license search (https://search.dca.ca.gov) uses Cloudflare Turnstile CAPTCHA
- Record count: Unknown
- Verdict: **blocked** — locator disallowed by robots.txt; DCA search has CAPTCHA

### 4. Indiana Professional Licensing Agency
- URL: https://www.in.gov/pla/
- robots.txt: Not found / no disallow
- Data access: mylicense.in.gov disallows all paths (Disallow: /). Interactive map only; no bulk CSV export on public site
- Record count: Unknown
- Verdict: **blocked** — edopl.idaho.gov Disallow: /; no public bulk download

### 5. Kentucky DHBC (contractors)
- URL: https://dhbc.ky.gov
- robots.txt: 404
- Data access: Individual license search only; no bulk CSV found
- Record count: Unknown
- Verdict: **insufficient** — no bulk export discovered

### 6. Utah DOPL
- URL: https://commerce.utah.gov/dopl/
- robots.txt: Allows all
- Data access: "Request a List of Licensees" requires login + payment ($0.01/record minimum $5)
- Record count: Unknown
- Verdict: **blocked** — requires paid subscription

### 7. New Mexico Construction Industries Division
- URL: https://www.rld.nm.gov/construction-industries/
- robots.txt: N/A
- Data access: Individual lookup only via PSI Exams third-party tool; no bulk export
- Record count: Unknown
- Verdict: **insufficient** — no bulk export

### 8. Rhode Island Contractors' Registration and Licensing Board (CRLB)
- URL: https://crb.ri.gov / https://datadbr.ri.gov/crb-search/contractor-search.php
- robots.txt: https://datadbr.ri.gov/robots.txt — No general Disallow; only restricts ZoomSpider to specific file extensions. General bots allowed.
- Data access: POST form at https://datadbr.ri.gov/crb-search/contractor-summary.php — returns full HTML table with all matching contractors. No CAPTCHA. No login required. No Cloudflare.
- Record count: ~17,300+ active registrations (Residential: 13,535; Commercial: 3,445; Commercial Roofer: 317; others: ~100)
- Fields available: License/Registration number, company name, contractor name, license type, status, expiration date
- Category mapping: carpinteria (general contractors, residential/commercial construction)
- Verdict: **viable** — selected for implementation

## Decision

**Rhode Island CRB** (slug: `rhode-island-crb`) was selected as the single viable candidate.

- Category: `carpinteria`
- State: RI
- Estimated records: ~17,000 active registrations
- Data access: POST HTML form, paginated by contractor type
- robots.txt: allowed (datadbr.ri.gov has no general Disallow)
- Auth: none; CAPTCHA: none; Cloudflare: none
