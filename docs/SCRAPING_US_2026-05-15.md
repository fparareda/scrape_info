# US Scraper Research — 2026-05-15

## Candidates evaluated

### Candidate A — Connecticut eLicense
- URL: https://www.elicense.ct.gov/Lookup/LicenseLookup.aspx
- Result: **NOT VIABLE** — Server-rendered HTML form; no bulk download, no API endpoint exposed. The page references data.ct.gov but CT open data portal timed out and yielded no licensing datasets.

### Candidate B — Indiana Professional Licensing Agency (IPLA)
- URL: https://www.in.gov/pla/
- Result: **NOT VIABLE** — No bulk data downloads. IPLA only exposes individual lookup and License Watch tool. Indiana hub (hub.mph.in.gov) has 2 IPLA datasets but they are opioid prescription / PDMP data, not licensee rosters.

### Candidate C — South Carolina LLR
- URL: https://verify.llronline.com/LicLookup/Lookup.aspx
- Result: **NOT VIABLE** — URL returned 404. opendata.sc.gov returned ECONNREFUSED. No viable bulk data path found.

### Candidate D — Kentucky Professional Licensing
- URL: https://secure.kentucky.gov/formservices/ProfessionalLicensing/LicenseVerification
- Result: **NOT VIABLE** — 404 on the license verification URL. No open data portal with contractor data found.

### Candidate E — Delaware Division of Professional Regulation (delpros.delaware.gov)
- URL: https://delpros.delaware.gov/OH_Web_Service/api/BoardLicenses
- Result: **NOT VIABLE** — Redirects to a login page. No public API available without authentication.

---

## Winner — Delaware Business Licenses (data.delaware.gov)

### Source details
- Portal: https://data.delaware.gov
- Dataset: Delaware Business Licenses
- Dataset ID: `5zy2-grhr`
- API: Socrata SODA REST API — `https://data.delaware.gov/resource/5zy2-grhr.json`
- State: Delaware (DE)

### Pre-flight checks
1. **robots.txt** — `https://data.delaware.gov/robots.txt` allows all bots; the `/resource/` Socrata endpoint is NOT in any Disallow rule. Only blocked: `/api/odata/`, `/OData.svc/`, browse-filter paths, edit paths. The SODA `/resource/` path is fully allowed. ✓
2. **Auth/WAF** — No authentication required for public dataset. SODA API returns JSON directly. ✓
3. **Record count** — 60,215 total business licenses; 12,048 with category "RESIDENT CONTRACTOR" or "NON-RESIDENT CONTRACTOR"; 8,200 of those have Delaware (DE) state addresses. Well above 500. ✓
4. **Fields** — `business_name`, `trade_name`, `category`, `address_1`, `address_2`, `city`, `state`, `zip`, `license_number`, `current_license_valid_from`, `current_license_valid_to`, `geocoded_location` ✓

### Category mapping
- "RESIDENT CONTRACTOR" + "NON-RESIDENT CONTRACTOR" → `carpinteria` (general contractors — closest taxonomy match)

### Implementation
- Slug: `delaware-contractor`
- Source name: `delaware-contractor`
- Env flag: `PROLIO_RUN_DELAWARE_CONTRACTOR=true`
- Limit env: `PROLIO_DELAWARE_CONTRACTOR_LIMIT=2000`
- Default limit: 2000
- Strategy: Paginated Socrata SODA API with `$limit=1000&$offset=N&$where=category+in+('RESIDENT+CONTRACTOR','NON-RESIDENT+CONTRACTOR')+AND+state='DE'`
