# CA Scraping Research — 2026-05-14

## Objective
Identify and implement a new Canadian scraper to fill gaps in the category taxonomy.
Priority: ingenieria (PEO, EGBC), notario (SNPBC), fisioterapia (CPTBC).

---

## Candidates Investigated

### 1. PEO — Professional Engineers Ontario
- URL: https://www.peo.on.ca/licence-holder-lookup
- robots.txt: Drupal-generated; disallows admin/search paths; licence-holder-lookup NOT disallowed
- **Viability: BLOCKED — Cloudflare WAF (managed challenge)**
  - Every request (plain curl, UA spoofing) receives a Cloudflare JS challenge page
  - Cannot be scraped without a headless browser and CAPTCHA solving
- Verdict: **SKIP**

### 2. EGBC — Engineers and Geoscientists BC
- URL: https://www.egbc.ca/Registration/Registrants-Practitioners/Find-a-Registrant
- robots.txt: 404 (not present)
- **Viability: BLOCKED — Cloudflare WAF (managed challenge)**
  - Homepage and all subpaths return Cloudflare challenge page
  - The `/api/Search` endpoint (tried directly) returns 403
- Verdict: **SKIP**

### 3. Society of Notaries Public of BC (SNPBC)
- Main site: https://www.snpbc.ca/ (redirected from notaries.bc.ca)
- Find-a-Notary: https://bcca-snpbc.ongovcore.com/public/verify-professional-license
- robots.txt: Standard WordPress robots.txt, `/wp-admin/` disallowed, everything else allowed
- Platform: ongovcore.com (Government Cloud SaaS)
- **Viability: BLOCKED — no accessible JSON API found**
  - The lookup tool is hosted on `bcca-snpbc.ongovcore.com`
  - Attempted multiple REST API patterns (api/public/professionals, api/v1/registrants/search,
    api/v2/public/professionals/search, api/search) — all returned 404
  - The platform likely requires browser session / CSRF tokens
  - BC notaries is a smaller body (~700 members) but API is not accessible
- Verdict: **SKIP** (no accessible API; platform-specific auth required)

### 4. CPTBC — College of Physical Therapists of BC (now "College of Health and Care Professionals of BC")
- URL: https://cptbc.alinityapp.com/client/publicdirectory
- robots.txt: Alinity platform; no specific disallow for /client/ paths
- Platform: **Alinity** (same SaaS used by CPM, CAP, TSASK, CPSA, etc.)
- **Viability: VIABLE**
  - Public directory shell loads successfully (no auth, no WAF)
  - querySID = 1000673 confirmed
  - POST to `/client/PublicDirectory/Registrants` returns JSON with `EnableCaptcha: false`
  - Record structure: `{rg, rl, rlm, ps, ef, ex, frd, hc, c, Conditions}`
    - `rg` = registrant GUID (UUID, stable unique identifier)
    - `rl` = "Last, First" display name
    - `ps` = status (Active / Not active)
    - `hc` = "hidden" (city not publicly disclosed by this college)
  - Saturation threshold observed at **75** (vs 25 for most Alinity tenants)
  - Two-char prefix sampling: sm=33, jo=65, ma=75, ch=75, ha=75, ba=75, ro=73
  - BC has ~5,000–7,000 registered physiotherapists → well above 500 minimum
  - No CAPTCHA, no login, returns JSON immediately
- **Record fields**: name (Last, First) + GUID + status + registration dates
- **Note**: City field is "hidden" — the college does not publish practice location in the
  public directory. The scraper will default citySlug to "vancouver" (largest BC metro).
  The GUID serves as the stable sourceId for deduplication.

**Selected source: CPTBC (cptbc-physio)**

---

## Implementation Decision

| Candidate | Category    | Records | robots.txt | Accessible API | Selected |
|-----------|------------|---------|------------|----------------|----------|
| PEO ON    | ingenieria | ~87,000 | OK         | NO (Cloudflare)| No       |
| EGBC BC   | ingenieria | ~40,000 | N/A        | NO (Cloudflare)| No       |
| SNPBC BC  | notario    | ~700    | OK         | NO (ongovcore) | No       |
| CPTBC BC  | fisioterapia | ~5,000+ | OK       | YES (Alinity)  | **Yes**  |

---

## Selected Endpoint

- **Source slug**: `cptbc-physio`
- **Platform**: Alinity tenant `cptbc`
- **Shell URL**: `https://cptbc.alinityapp.com/client/publicdirectory`
- **Search URL**: `POST https://cptbc.alinityapp.com/client/PublicDirectory/Registrants`
- **querySID**: 1000673 (fetched dynamically from shell page)
- **Category**: `fisioterapia`
- **Province**: BC
- **Default city**: `vancouver`
- **Pre-flight date**: 2026-05-14
