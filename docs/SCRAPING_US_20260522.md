# US Scraper Scouting — 2026-05-22

Scouted one new US source for ingenieria + arquitecto categories.

## Candidates evaluated

### 1. South Carolina LLR (verify.llronline.com) — BLOCKED
- `verify.llronline.com` returns HTTP 403 and too-many-redirects on all direct access
- robots.txt returns 404 on verify.llronline.com (no robots.txt file at all)
- `llr.sc.gov` main site: robots.txt allows scraping (only disallows /inc/, /dev, etc.)
- The ASP.NET ASPX verification pages loop on redirects; no bulk export found
- Paid bulk verification service only at scllr.joportal.com
- **Status: SKIPPED — redirect loops + no accessible bulk endpoint**

### 2. Utah DOPL (secure.utah.gov/datarequest) — PAID
- License data available at Utah Data Request portal
- Minimum $5 fee + $0.03/record for address data
- db.dopl.utah.gov/cbr/ (Construction Business Registry): opt-in only, no bulk download
- **Status: SKIPPED — requires payment**

### 3. Delaware Division of Professional Regulation — LOGIN REQUIRED
- delpros.delaware.gov requires account creation and login
- No public bulk search or download
- **Status: SKIPPED — login wall**

### 4. New Mexico RLD — JS-ONLY SPA
- nmrldlpi.my.site.com (Salesforce Experience Cloud) — JavaScript SPA
- No server-rendered HTML or accessible JSON endpoint
- **Status: SKIPPED — JS-only SPA**

### 5. Oklahoma Construction Industries Board — NO BULK DOWNLOAD
- okcibv7prod.glsuite.us: ASP.NET form requiring 3-char minimum searches
- No CSV export or bulk download option
- **Status: SKIPPED — no bulk access**

### 6. West Virginia Contractor Licensing Board — ROBOTS BLOCKED
- wvclboard.wv.gov robots.txt: `User-agent: * / Disallow: /`
- wvlabor.com (HVAC/plumber search): network timeout from datacenter IPs
- **Status: SKIPPED — blocked by robots.txt and connectivity**

### 7. Arkansas Contractors Licensing Board (aclb2.arkansas.gov) — TIMEOUT
- aclb2.arkansas.gov consistently times out
- latestroster.csv mentioned as available but requires purchase ($0.03/record)
- labor.arkansas.gov HVAC and electrician roster forms: POST-only WordPress shortcode, no GET access
- **Status: SKIPPED — purchase required + connectivity issues**

### 8. Kansas KBTP (licensing.ks.gov) — RECAPTCHA
- Kansas License Verification Portal has reCAPTCHA on all searches
- KBTP (Board of Technical Professions) covers architects/engineers but no bulk export
- **Status: SKIPPED — reCAPTCHA on search**

### 9. Nebraska Board of Engineers and Architects — IMPLEMENTED ✓
- URL: https://www.nebraska.gov/ea/search/search.php
- robots.txt at nebraska.gov: only `/demo/billtrack/` and `/app-fsp/` disallowed; `/ea/` unrestricted
- Server-rendered PHP/HTML, Bootstrap 3 UI, no auth/CAPTCHA/WAF
- Session-based pagination: POST initial search → PHP session cookie → GET `?page=search&page_num=N`
- 20 rows per page; page_num increments by 20
- Active licensees: ~9,651 engineers + ~1,931 architects = ~11,582 total
- Data updated weekly; last update 2026-05-13
- Categories: Engineer → `ingenieria`, Architect → `arquitecto`
- State: NE (Nebraska), but covers nationwide residents licensed in Nebraska
- **Status: IMPLEMENTED — slug `nebraska-ea`**

## Candidate summary

| Candidate | Status | Reason |
|-----------|--------|--------|
| SC LLR verify.llronline.com | SKIPPED | Redirect loops, no bulk access |
| Utah DOPL data request | SKIPPED | Requires payment |
| Delaware DPR | SKIPPED | Login required |
| New Mexico RLD | SKIPPED | JS-only SPA (Salesforce) |
| Oklahoma CIB | SKIPPED | No bulk download |
| West Virginia CLB | SKIPPED | robots.txt Disallow: / |
| Arkansas CLB | SKIPPED | Paid + connectivity timeout |
| Kansas KBTP | SKIPPED | reCAPTCHA |
| **Nebraska EA Board** | **IMPLEMENTED** | Public PHP search, session pagination |

## Implementation

- Source file: `src/sources/nebraska-ea.ts`
- ScrapeSource type: `"nebraska-ea"` added to `src/types.ts`
- Index wiring: `src/index.ts` (import, flag, guard, exec loop)
- Runner env: `.github/workflows/_scrape-runner.yml`
- Workflow: `.github/workflows/scrape-nebraska-ea.yml` (cron: 12th of month, 07:00 UTC)
