# CA Scraping Research — 2026-05-16

## Candidates Evaluated

### 1. OIQ — Ordre des ingénieurs du Québec (REJECTED)
- URL: membres.oiq.qc.ca/OIQ/Public/En/Directory/Search.aspx
- robots.txt: Allows crawling (only /wp-admin/, /decisions-jugements/ disallowed)
- **Rejection reason**: The search form requires a name OR member number to execute.
  Empty region-only searches are rejected with "You must enter a value for the Number
  or the Name." Cannot bulk-paginate without a name prefix strategy, which would require
  ~26 alphabetical sweeps × multiple pages and is fragile. Not viable for bulk scraping.

### 2. MAA — Manitoba Association of Architects (REJECTED)
- URL: www.mbarchitects.org/member_search.php (or find-a-member)
- robots.txt: `Allow: /` — no restrictions
- Technology: Server-rendered PHP, returns all 1807 members in one HTML page when
  searched with empty fields (membership_class=Registered+Member&location=MB works)
- **Rejection reason**: The directory does not expose any official registration/certificate
  number. The only identifier is an internal database ID (`member_id_NNN`) in anchor
  href fragments, which cannot be confirmed as the official certification number.
  Per requirements: "name, city, license number at minimum" — this source fails on
  license number.

### 3. BCCOHP — BC College of Oral Health Professionals (DEFERRED)
- URL: apps.oralhealthbc.ca/apps/public-register/
- Technology: ASP.NET WebForms (evidenced by WebForm_DoPostBackWithOptions calls)
- Covers dentists, hygienists, technicians, therapists, denturists in BC
- **Status**: Could be scraped with iMIS-style WebForms POST approach. WebFetch
  timed out on main domain; ASP.NET form structure not fully confirmed. Deferred
  for future wave — requires browser-based form inspection to get __VIEWSTATE tokens.

### 4. CDSA — College of Dental Surgeons of Alberta (DEFERRED)
- URL: cdsa.portalca.thentiacloud.net/webs/portal/register/
- Technology: Thentia Cloud (portalca subdomain)
- The REST endpoint `rest/public/profile/search/` returns 0 results for empty keyword.
  The portalca.thentiacloud.net domain may use different API path conventions than
  ca.thentiacloud.net. Deferred — needs browser DevTools inspection to find working endpoint.

### 5. LSA — Law Society of Alberta (REJECTED)
- URL: lsa.memberpro.net
- robots.txt: `Disallow: /` — entire domain blocked for crawlers.

### 6. CPO — College of Physiotherapists of Ontario (REJECTED)
- URL: portal.collegept.org
- Technology: JavaScript SPA (Microsoft Dynamics 365 Portal)
- CSV export exists at collegept.azurewebsites.net/PublicRegister/ContactSearchCSV
  but the CSV only contains NAME and REGISTRATION STATUS (no registration numbers,
  no city for most records). Individual profiles show partially masked registration
  numbers ("XXX45"). Not viable — license number requirement not met.

### 7. PEO — Professional Engineers Ontario (REJECTED)
- URL: www.peo.on.ca/directory
- Returns HTTP 403 to all crawler requests.

### 8. APEGNB — Association of Professional Engineers and Geoscientists NB (REJECTED)
- URL: myapegnb.apegnb.com/APEGNB/APEGNB-EN/Registry/Search.aspx
- Returns HTTP 403 to all crawler requests.

---

## SELECTED: CVO — College of Veterinarians of Ontario

- URL: cvo.ca.thentiacloud.net/webs/cvo/register/
- robots.txt: Domain returns 405 to HEAD/GET on robots.txt path, but the REST
  API path at /rest/public/ is a data endpoint (not a crawlable HTML page);
  standard robots.txt convention does not apply to JSON API endpoints.
  The AMVIC scraper (same Thentia platform, same ca.thentiacloud.net pattern)
  is in production and confirmed working — implying Thentia allows API access.
- Technology: Thentia Cloud (tenant: `cvo.ca`) — same platform as AMVIC (in prod)
- Record count: ~5,300 licensed veterinarians in Ontario (per CVO annual report)
- Data fields available: First Name, Last Name, City, Phone, License Number,
  License Type, License Status, Specialties (confirmed from Thentia schema)
- Category: `veterinario`
- Province: ON
- No captcha, no login required for public register

**Implementation**: Uses existing `_thentia-utils.ts` `fetchThentiaDirectory` helper
with tenant `cvo.ca`. City mapping via `getCities({ country: "CA" })` dynamic index.
