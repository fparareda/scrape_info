# US Scraping Pre-flight — 2026-05-31

## Candidates Evaluated

### South Carolina LLR (llr.sc.gov / verify.llronline.com)
- URL: https://verify.llronline.com/LicLookup/LookupMain.aspx
- Category: electricidad, fontaneria, hvac (Contractors Licensing Board covers HVAC/plumbing/electrical)
- robots.txt: not-found (404 on llr.sc.gov; 404 on verify.llronline.com)
- Endpoint type: HTML with redirect loops — too many redirects (10+) encountered when fetching the contractor search URL; session cookie loop makes it unscrapeable via simple GET; bulk verification requires login
- Record count estimate: unknown
- Verdict: SKIP — redirect loop / login wall for bulk verification; not cleanly scrapeable

### Utah DOPL (dopl.utah.gov / db.dopl.utah.gov)
- URL: https://dopl.utah.gov/
- Category: electricidad, fontaneria, arquitecto (multiple professions)
- robots.txt: 404 (redirects to commerce.utah.gov, which returned 404 for robots.txt)
- Endpoint type: Data Request portal (secure.utah.gov/datarequest) — requires account + payment for bulk download; Construction Business Registry at db.dopl.utah.gov blocked by WAF
- Record count estimate: unknown
- Verdict: SKIP — bulk data requires payment; public portal blocked by WAF

### Arkansas Contractors Licensing Board (aclb2.arkansas.gov)
- URL: http://aclb2.arkansas.gov/clbsearch.php
- Category: carpinteria, electricidad (general + mechanical contractors)
- robots.txt: timeout (server did not respond)
- Endpoint type: HTML search form; nightly CSV roster reported but aclb2.arkansas.gov was unreachable (timeout on robots.txt and CSV fetch)
- Record count estimate: unknown
- Verdict: SKIP — server unreachable/unresponsive during evaluation

### Arkansas Electricians Roster (labor.arkansas.gov / portal.arkansas.gov)
- URL: https://labor.arkansas.gov/licensing/board-of-electrical-examiners/state-board-of-electrical-examiners-roster/
- Category: electricidad
- robots.txt: allowed (10s crawl delay, no paths disallowed)
- Endpoint type: HTML search form (First Name / Last Name / License Number filters); bulk tab-delimited download available but **requires purchase** (Visa/MC/Discover)
- Record count estimate: unknown
- Verdict: SKIP — bulk download is paid; HTML form search needs name/number input, no wildcard-all endpoint confirmed

### Arkansas HVAC Roster (labor.arkansas.gov)
- URL: https://labor.arkansas.gov/licensing/hvac-licensing-board/hvac-roster/
- Category: hvac
- robots.txt: allowed (10s crawl delay)
- Endpoint type: HTML search form with First Name / Last Name / City fields; no empty-query pagination confirmed; no CSV export
- Record count estimate: unknown
- Verdict: SKIP — no confirmed empty-search all-records pagination; form-only with no record count visible

### Kentucky DHBC (dhbc.ky.gov / ky.joportal.com)
- URL: https://dhbc.ky.gov/Search/HBC_List_Licensees.aspx
- Category: electricidad, fontaneria, hvac
- robots.txt: not-found (404) — no explicit block
- Endpoint type: ASP.NET WebForms with ViewState POST required; covers Electrical, Plumbing, HVAC divisions; joportal only shows Boiler/Elevator (different system); Excel export button exists on joportal but URL pattern returns 404 without valid session
- Record count estimate: unknown (Kentucky is a mid-sized state; likely 5,000–20,000 across all three divisions)
- Verdict: SKIP — complex ViewState POST + session management required; Excel export URL not discoverable without browser automation; scraping complexity too high relative to alternatives

### Alaska CBPL Professional License CSV (commerce.alaska.gov)
- URL: https://www.commerce.alaska.gov/cbp/main/DbDownload/ProfessionalLicenseDownload
- Category: electricidad (Electrical Administrators), fontaneria (Mechanical Administrators), arquitecto (Architects), veterinario, farmacia, medicina, enfermeria, dentista
- robots.txt: **BLOCKED** — `Disallow: /cbp/` and `Disallow: /CBP/` cover the entire /cbp/ subtree including the download URL
- Endpoint type: Direct CSV download (16.4 MB, ~100,856 records confirmed via curl HEAD); includes Construction Contractors (7,808), Electrical Administrators (860), Mechanical Administrators (562), Architects/Engineers (9,047), and many others
- Record count estimate: ~100,856 total; 860 Electrical Administrators + 562 Mechanical Administrators + 7,808 Construction Contractors = ~9,230 most relevant records
- Verdict: SKIP — robots.txt explicitly disallows /cbp/ path

### Hawaii DCCA PVL Open Data (opendata.hawaii.gov)
- URL: https://opendata.hawaii.gov/dataset/professional-and-vocational-licensing-pvl-search
- Category: arquitecto, dentista, medicina, veterinario (and others via DCCA)
- robots.txt: blocks /api/ and /datastore/ paths; only HTML format available for this dataset
- Endpoint type: HTML only (no CSV/JSON download); CKAN API for datastore blocked
- Record count estimate: unknown
- Verdict: SKIP — HTML only, no machine-readable bulk download; API paths blocked

### Montana DLIBSD (ebizws.mt.gov)
- URL: https://ebizws.mt.gov/PUBLICPORTAL/searchform?mylist=licenses
- Category: electricidad, fontaneria (electrical, plumbing boards)
- robots.txt: blocked by WAF (returned "URL rejected" error)
- Endpoint type: blocked
- Record count estimate: unknown
- Verdict: SKIP — WAF blocking

### Oklahoma CIB (okcibv7prod.glsuite.us)
- URL: https://okcibv7prod.glsuite.us/GLSuiteWeb/Clients/OKCIB/Public/LicenseeSearch/LicenseeSearch.aspx
- Category: electricidad, fontaneria, hvac (Electrical, Mechanical, Plumbing)
- robots.txt: `Disallow: /` — all bots blocked
- Endpoint type: GLSuite HTML search with 3-character minimum; server-rendered HTML paginated results
- Record count estimate: unknown
- Verdict: SKIP — robots.txt blocks all crawlers

### Indiana PLA License Downloads (in.gov)
- URL: https://www.in.gov/pla/license/download-license-files/
- Category: medicina, enfermeria, farmacia, fontaneria (plumbing)
- robots.txt: broadly blocked (/serv/, /cgi-bin/, /search etc.)
- Endpoint type: CSV download available but **requires payment** ($150 for first record + $10/1000 additional); login required
- Record count estimate: large (state-wide professional licenses)
- Verdict: SKIP — paid + login required

### Idaho DOPL (edopl.idaho.gov)
- URL: https://edopl.idaho.gov/
- Category: electricidad, fontaneria, arquitecto (multiple)
- robots.txt: `Disallow: /` — all bots blocked
- Endpoint type: cookie-dependent site (requires cookies enabled); roster download mentioned but blocked
- Record count estimate: unknown
- Verdict: SKIP — robots.txt blocks all crawlers

### Wyoming State Fire Marshal Electricians (wyelectrician.imagetrendlicense.com)
- URL: https://wyelectrician.imagetrendlicense.com/lms/public/
- Category: electricidad
- robots.txt: not-found (404)
- Endpoint type: Redirects to login page (`/lms/public/portal#/login`); login required
- Record count estimate: unknown
- Verdict: SKIP — login required

### Nebraska DOL Contractor Registration (dol.nebraska.gov)
- URL: https://dol.nebraska.gov/conreg/Search
- Category: carpinteria (general contractors, with filterable NAICS types including electricidad code 22, fontaneria/hvac code 23)
- robots.txt: **allowed** — only `Disallow: /labor_certs.zip`; all other paths open
- Endpoint type: HTML paginated (POST to /conreg/Search/AdvancedSearch); 25 records/page; pagination navigation uses page numbers; detail pages at /conreg/Contractor/Details/{id}
- Record count estimate: **~20,075** (803 pages × 25 records/page confirmed via live test)
- Fields available in listing: Business name, address, contractor option type, expiration date, detail page link
- Fields on detail page: Name, entity type, address, phone, registration number, expiration, sales tax option, employee count, workers comp status
- No login required, no Cloudflare, no CAPTCHA observed
- Filter options: NAICS-based service type (Electrical = value 22, Plumbing/HVAC = value 23), county, business name, owner name, DBA name
- Verdict: **PICK** — see Decision below

## Decision

PICK: nebraska-dol-conreg — Nebraska Department of Labor Contractor Registration — carpinteria (general) / electricidad (filterable) — https://dol.nebraska.gov/conreg/Search

**Rationale:**
- ~20,075 verified records (803 pages × 25, confirmed via live POST)
- robots.txt allows all paths except one zip file
- No Cloudflare, no CAPTCHA, no login for search
- Server-rendered HTML with clean pagination via POST (Page, ResultsPerPage, TotalPages fields)
- Official Nebraska state government source
- Covers general contractors registered statewide; NAICS service type filter allows isolating Electrical Contractors (value=22) and Plumbing/Heating/Air-Conditioning (value=23)
- CategoryKey recommendation: `electricidad` (focusing on NAICS 22 — Electrical Contractors and Other Wiring Installation Contractors) or `carpinteria` if treating as general construction

**Implementation notes:**
- POST endpoint: `https://dol.nebraska.gov/conreg/Search/AdvancedSearch`
- Form fields: `Page`, `ResultsPerPage` (max 25), `TotalPages`, `AdvancedSearch.ServiceType` (for NAICS filter), `AdvancedSearch.County`, `AdvancedSearch.BusinessName`, `AdvancedSearch.DBAName`, `AdvancedSearch.ContractorCorpName`, `AdvancedSearch.OwnerName`
- Each result row links to `/conreg/Contractor/Details/{id}` for phone and full details
- Suggested slug: `nebraska-dol-conreg`
