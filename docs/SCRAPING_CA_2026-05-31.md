# CA Scraping Pre-flight — 2026-05-31

## Candidates Evaluated

### RCDSO — Royal College of Dental Surgeons of Ontario (dentista)
- URL: https://www.rcdso.org/en-ca/find-a-dentist
- Category: dentista
- robots.txt: allowed (only /scripts and /styles blocked; root allowed; ClaudeBot blocked by user-agent)
- Endpoint type: BLOCKED — search results URL returns HTTP 403 Forbidden
- Record count estimate: unknown (estimated ~10,000+ Ontario dentists)
- Verdict: SKIP: search results endpoint returns 403 Forbidden; user-agent blocking of ClaudeBot in robots.txt also noted

### College of Physiotherapists of Ontario — CPO Public Register (fisioterapia)
- URL: https://collegept.azurewebsites.net/PublicRegister/ContactSearch
- Category: fisioterapia
- robots.txt: collegept.org robots.txt only blocks /wp-admin/ (standard); portal.collegept.org returns 404 (no restrictions file); collegept.azurewebsites.net returns 404 (no restrictions file) — no crawl restrictions on the public register endpoint
- Endpoint type: HTML paginated (10 records per page, 1,931 pages) + CSV bulk download at collegept.azurewebsites.net/PublicRegister/ContactSearchCSV
- Record count estimate: 19,305 (displayed as "1 - 10 of 19,305 Physiotherapists" on the live endpoint)
- Fields available: name, registration number, registration status, clinic name, address, city, postal code, phone number, additional practice locations
- Verdict: PICK — official Ontario regulatory body, 19,305 public records, no login, no CAPTCHA, no Cloudflare, server-rendered HTML pagination, CSV bulk export confirmed working

### College of Physiotherapists of Alberta — CPTA (fisioterapia)
- URL: https://cpta.alinityapp.com/client/publicdirectory
- Category: fisioterapia
- robots.txt: cpta.ab.ca allows / (only /admin/ and /django-admin/ blocked)
- Endpoint type: JavaScript-heavy (Alinity SPA, client-side rendering with template variables like [[_fn_]]); search results limited to 25 matches
- Record count estimate: unknown
- Verdict: SKIP: JavaScript-heavy SPA not suitable for server-rendered scraping; 25-result cap makes bulk enumeration impractical

### College of Psychologists of Ontario (redirects to CPBAO) (psicologia)
- URL: https://cpbao.ca/public/find-a-psychologist/
- Category: psicologia
- robots.txt: not checked (URL returned 404)
- Endpoint type: BLOCKED — 404 Not Found
- Record count estimate: unknown
- Verdict: SKIP: directory URL returns 404

### Alberta College of Pharmacy — ACP (farmacia)
- URL: https://abpharmacy.ca/public-register-disclaimer/
- Category: farmacia
- robots.txt: allowed (only /wp-admin/ and /wp-content/uploads/_pda/* blocked)
- Endpoint type: Embedded WordPress page with search widget — no standalone paginated endpoint identified; no Alinity URL found for Alberta pharmacy
- Record count estimate: unknown
- Verdict: SKIP: no clear scrapeable paginated or API endpoint found; search appears embedded in WordPress page without a structured URL pattern

---

## Decision

PICK: cpo-on-physio — College of Physiotherapists of Ontario Public Register — fisioterapia — https://collegept.azurewebsites.net/PublicRegister/ContactSearch

**Rationale:**
- Official Ontario regulatory college under the Regulated Health Professions Act
- 19,305 registrant records (all statuses: active, resigned, expired, revoked, etc.)
- Server-rendered HTML, 10 records per page, clean pagination via `?p=N` parameter
- No login, no CAPTCHA, no Cloudflare challenge
- robots.txt on all relevant domains either returns 404 (no file = no restrictions) or only blocks /wp-admin/
- Bulk CSV download also confirmed working at the same Azure subdomain
- Fields: name, registration number, status, clinic name, full address, city, postal code, phone
- Fills a gap: fisioterapia has CPM (MB) and OPPQ (QC) covered; NSCP (NS) is an open PR; Ontario is the largest province and currently uncovered
