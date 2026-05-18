# CA Scraping Pre-flight — 2026-05-18

## Taxonomy gap targeted
`fisioterapia` — Ontario (largest Canadian physiotherapy workforce) was not
covered. Existing CA fisioterapia: Manitoba (CPM, iMIS-hosted). Open PR #13
covers BC (CPTBC). Ontario is the remaining gap.

## Candidates researched

### College of Physiotherapists of Ontario (CPO) ✅ SELECTED
- URL: https://collegept.org/public-register
- Backend: https://collegept.azurewebsites.net/PublicRegister/
- **STATUS: VIABLE**
- robots.txt:
  - `collegept.org`: only Disallows `/wp-admin/` — all register paths open.
  - `collegept.azurewebsites.net`: HTTP 404 (no robots.txt) → all paths allowed.
- Auth / captcha / Cloudflare: none.
- Records: 19,302 total (confirmed via paginated HTML); ~11,000+ active.
- CSV bulk endpoint: `https://collegept.azurewebsites.net/PublicRegister/ContactSearchCsv?...`
- Fields: NAME, REGISTRATION STATUS, CLINIC NAME, ADDRESS, POSTAL CODE, CITY, PHONE,
  ADDITIONAL PRACTICE LOCATIONS.
- Strategy: single bulk GET to CSV endpoint → parse → filter active → map city.
- Category: `fisioterapia`.
- Cadence: monthly (college rolls update monthly).

### ABVMA — Alberta Veterinary Medical Association
- URL: https://www.abvma.ca/client/roster/
- **STATUS: BLOCKED BY ROBOTS.TXT** — `Disallow: /client/roster/` explicitly
  blocks the member roster path. Records: ~2,066.

### CVO — College of Veterinarians of Ontario
- Platform: Thentia Cloud (`cvo.ca.thentiacloud.net`) — 405 Method Not Allowed
  on direct fetch; JS-heavy SPA. **NOT VIABLE** without Playwright.

### CVBC — College of Veterinarians of BC
- **STATUS: FORM-BASED POST** — search requires form interaction; action URL not
  exposed in HTML. Not automatable without Playwright. **NOT VIABLE**.

### CDSBC — College of Dental Surgeons of BC
- **STATUS: TIMED OUT** — probable Cloudflare protection. **NOT VIABLE**.

## Decision
CPO selected. Scraper at `src/sources/cpo-physio.ts`, source key `cpo-physio`,
category `fisioterapia`. 19,302 records far exceeds 500-record threshold; rich
contact fields including address + phone; single bulk CSV download minimises
host load.
