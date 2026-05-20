# US Scraper Expansion — Research Log 2026-05-20

Research date: 2026-05-20  
Task: find one new scrapeable US source for a category not yet covered.

## Candidate evaluation order

Categories investigated: psicologia, fisioterapia, extranjeria, cerrajero, hvac.

---

### 1. psicologia — California Board of Psychology / ASPPB

**psychology.ca.gov** — robots.txt allows all non-asset paths. However,
the licensee search lives at `search.dca.ca.gov` (shared DCA system),
which requires JavaScript to render results. No static HTML result pages
are available; the React SPA loads data via XHR after JS execution.
**FAILED — JS-only, not plain-HTTP scrapeable without a browser.**

**ASPPB** — The national psychology board body operates only a closed
record verification service (CRVS), not a public directory. No bulk
endpoint found. **FAILED — no public listing.**

**Texas BHEC CSV (bhec.texas.gov/csv/PSY.csv)** — A CSV is available
with ~1,200 active TX psychologists. However, it contains only name +
license number + status — no address or city field. City resolution
would fail for every row. **FAILED — no address/city data.**

---

### 2. fisioterapia — FSBPT / NPI Registry

**FSBPT Therapist Data Trust (fsbpt.org)** — The "Find a Licensed
Physical Therapist" page directs users to the APTA member directory and
individual state PT boards, not a searchable FSBPT-hosted database. The
PT Compact Commission verification portal at `purchase.ptcompact.org`
returned HTTP 500 and has no bulk export. **FAILED — no bulk endpoint.**

**NPI Registry / NPPES V2 API** — Pre-flight confirmed:

```
GET https://npiregistry.cms.hhs.gov/api/?version=2.1
    &taxonomy_description=Physical+Therapist
    &state=CA&limit=200&skip=0
→ 200 OK, result_count=200 (cap hit; many more pages available)

GET https://npiregistry.cms.hhs.gov/api/?version=2.1
    &taxonomy_description=Physical+Therapist
    &state=NY&limit=200&skip=0
→ 200 OK, result_count=200 (cap hit)
```

- **robots.txt**: npiregistry.cms.hhs.gov/robots.txt is permissive; no
  Disallow for /api/.
- **Auth / WAF**: none. Public unauthenticated JSON API.
- **Records**: NPPES publishes ~230k individual Physical Therapist NPIs
  nationally. 51 states × 4 taxonomies × up to 1200 rows/combo = ~245k
  ceiling per run, well above the 500-record minimum.
- **Data quality**: each record includes NPI, full name, address
  (street + city + state + ZIP), phone, and taxonomy/license metadata.
  City field maps cleanly to the city-slug index.
- **PICKED**: NPI Physical Therapists → `fisioterapia` category.

---

### 3. extranjeria — AILA immigration attorney directory

**ailalawyer.com** — robots.txt allows all paths (Allow: /). However,
the search form returns no data without JavaScript execution; the page
body is an empty React shell. The underlying search API endpoint could
not be identified from static fetches. **FAILED — JS-only SPA.**

---

### 4. cerrajero — ALOA / state locksmith boards

**aloa.org/find-a-locksmith** — 404 (directory not at that path).
FindLocksmith.com (ALOA-affiliated) allows robots but page body was
empty, suggesting a JS-rendered SPA. **FAILED — no accessible directory.**

**Maryland DLLR locksmith lookup** — Requires specific search parameters
(name/license number); no browse-all mode. **FAILED — no bulk access.**

**California BSIS via search.dca.ca.gov** — Same DCA JS-rendered SPA
as the psychology board. No static HTML results. **FAILED — JS-only.**

---

### 5. hvac — EPA Section 608

**epa608.com technician lookup** — Third-party site with a search form.
Not an authoritative government source; individual lookups only; no bulk
export identified. **FAILED — not authoritative and no bulk access.**

---

## Decision

**PICKED**: `npi-physical-therapists` — US fisioterapia (Physical
Therapists) sourced from the CMS NPPES NPI Registry V2 API.

Rationale:
- Only viable candidate found with: (a) plain HTTP/JSON access with no
  WAF/captcha/login, (b) robots.txt allows /api/, (c) ≥500 records (est.
  ~230k nationally), (d) city + address data present for slug resolution.
- Fits an existing NPI-slicing pattern already used for `enfermeria`
  (npi-nurses) and `farmacia` (npi-pharmacists) — minimal net-new code.
- `fisioterapia` was the highest-priority uncovered US category.

## Implementation

File: `src/sources/npi-physical-therapists.ts`  
Workflow: `.github/workflows/scrape-npi-physical-therapists.yml`  
Runner env: `PROLIO_RUN_NPI_PHYSICAL_THERAPISTS` / `PROLIO_NPI_PHYSICAL_THERAPISTS_LIMIT`  
Schedule: day 25 of month at 06:00 UTC (offset from nurses=24 and pharmacists to avoid overlap)
