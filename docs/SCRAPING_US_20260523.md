# Scout Run — 2026-05-23 — US / ES / CA

Automated scout run via scrape_info agent. One new scrapeable source
per country per run (inside existing taxonomy). Results below.

---

## US ✅ — iowa-dial-contractors (IMPLEMENTED)

**Source:** Iowa DIAL — Active Iowa Construction Contractor Registrations  
**URL:** https://data.iowa.gov/Workforce/Active-Iowa-Construction-Contractor-Registrations/dpf3-iz94  
**CSV endpoint:** `https://data.iowa.gov/api/views/dpf3-iz94/rows.csv?accessType=DOWNLOAD`

**Pre-flight (2026-05-23):**
- robots.txt: ALLOWED — only blocks `/browse?*` filter paths; CSV download path unrestricted
- Record count: **17,246** active registrations (verified via Socrata count API)
- JS required: **NO** — direct HTTP GET, no JavaScript, no auth, no CAPTCHA
- Cloudflare/WAF: **NONE**
- Data fields: Registration #, Primary Activity (NAICS code + description),
  Business Name, First Name, Last Name, Email Address, Address 1, Address 2,
  City, State, Zip Code, County, Phone, Issue Date, Expire Date
- Update cadence: weekly (Socrata dataset refreshed weekly)

**NAICS → CategoryKey mapping:**
| NAICS prefix | Description | Category |
|---|---|---|
| 23821x | Electrical Contractors | electricidad |
| 23822x | Plumbing, Heating & A/C | hvac |
| 236xxx | Building Construction | carpinteria |
| 238xxx (other) | Specialty Trades | carpinteria |
| 230000 | Other/Undefined | skipped |

**Why Iowa:** Not covered by any existing state board. Iowa mandates
registration for any contractor earning ≥ $2,000/year from Iowa construction.
This delivers near-complete in-state market coverage for trades.

**Implementation:** `src/sources/iowa-dial-contractors.ts`  
**Cron:** monthly (annual-data cadence) — `scrape-iowa-dial-contractors.yml`  
**Flag:** `PROLIO_RUN_IOWA_DIAL_CONTRACTORS=true`

---

## ES ⏭️ — SKIP

**Best candidate found:** Registro de Gestores Administrativos de España  
**URL:** https://registro.consejogestores.org/

**Pre-flight:**
- Record count: ~1,040 (above 500-record threshold)
- JS required: NO (server-rendered HTML, GET pagination)
- Taxonomy match: `fiscal` / `extranjeria` (gestores handle tax filings,
  DGT/vehicle, immigration paperwork)
- robots.txt: `Disallow: /*?*` — blocks **all** URLs with query parameters,
  which is the only pagination mechanism (`?pageNumber=N`). Only the root
  page (10 records) is technically crawlable without violating this rule.

**Decision:** SKIP — robots.txt query-param block prevents full dataset
access. Other candidates were blocked (CGATE: explicit ToS prohibition on
data storage; APECS cerrajeros: ~80 members, too small; UCES: Google Maps
embed, JS-only).

**Human action needed:** If the robots.txt restriction is lifted or an
alternate endpoint appears, the gestores scraper is low-complexity and
can be implemented quickly (~1,040 records, HTML pagination, `fiscal` cat).

---

## CA ⏭️ — SKIP

**Candidates researched:**

| Candidate | Category | Records | Verdict |
|---|---|---|---|
| Alberta College of Pharmacy (ACP) | farmacia | ~6,600 | ToS prohibits research/marketing use; form uses Gravity Forms + uncertain POST mechanism |
| OMVIC (Ontario Motor Vehicle Industry Council) | mecanica | 8,000+ | PowerApps SPA — JavaScript-only, no server-rendered data |
| AIBC (Architectural Institute of BC) | arquitecto | ~5,400 | Gravity Forms with AJAX result rendering (POST returns form confirmation, not member list) |
| Ordre des ingénieurs du Québec (OIQ) | ingenieria | ~70,000 | JavaScript spinner on search — client-side rendering |
| CPA BC | fiscal | ~40,000 | ToS prohibits commercial use; ASP.NET ViewState POST required |
| CPA Alberta | fiscal | ~28,500 | Robots OK; but exact-match ASP.NET POST with uncertain behavior; no ToS concern flagged |
| Technical Safety BC | electricidad/hvac | ~15,000 | robots.txt blocks `/api/*` and `/search`; Next.js SPA |
| NBCP (NB pharmacists) | farmacia | ~994 | Alinity-hosted; JS-only; too small |

**Decision:** SKIP — no candidate passes all viability criteria simultaneously
without browser-level testing. The best unblocked candidate (CPA Alberta) has
an uncertain server-side POST mechanism that needs browser network-inspection
before implementation.

**Human action needed:** 
1. CPA Alberta (`services.cpaalberta.ca/VerifyEntity/Members/`) — verify
   whether the ASP.NET form accepts single-letter last-name prefix searches
   (e.g. POST `LastName=a` returns all CPAs with last names starting in A).
   If yes, ~28,500 `fiscal` records are accessible.
2. AIBC (`aibc.ca/resources/online-directory/`) — capture the actual
   admin-ajax.php action name via browser DevTools network tab. If the
   form POSTs to `/wp-admin/admin-ajax.php?action=<X>` and returns HTML
   member rows, ~5,400 `arquitecto` records are accessible.
