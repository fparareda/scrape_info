# US Scraper Research — 2026-06-15

## Summary

Researched new US professional/trade record sources for categories not yet
covered. Selected and implemented **Delaware DPR** (Socrata) as the new source.

---

## Candidates Evaluated

### 1. Texas Board of Architectural Examiners (TBAE)
- URL: https://indreg.tbae.texas.gov/Reports/IndividualSearch
- **Result: REJECTED**
- The individual search is a session-bound form with no bulk CSV export.
- data.texas.gov shows no TBAE licensee dataset in the open data catalog.
- Access requires either FOIA request or Playwright adapter.

### 2. NCARB Architect Lookup
- URL: https://www.ncarb.org/ncarb-certificate/benefits/lookup
- **Result: REJECTED**
- Likely SPA/JavaScript-rendered; no documented public API.
- Not investigated further given TBAE and DE alternatives.

### 3. Indiana VetBoard Veterinary License Dashboard
- URL: https://hub.mph.in.gov/dataset/d8616348-7740-4f69-9651-72649f52cb45/...
- **Result: REJECTED**
- CSV download confirmed working (~1.5 MB).
- Only ~900 rows total; these are workforce survey responses (demographics),
  NOT individual licensee names + license numbers. No `name` or `license_no`
  field present. Does not constitute a licensee directory.

### 4. Oregon Veterinary Medical Examining Board
- URL: https://ovmeb.us.thentiacloud.net/webs/ovmeb/register/
- **Result: REJECTED** (for now)
- Public register is Thentia-hosted — same pattern as other CA sources
  already in flight. No bulk download found; per-page HTML scrape feasible
  but out of scope for this pass.

### 5. North Carolina Veterinary Medical Board
- URL: https://portal.ncvmb.org/verification/search.aspx
- **Result: REJECTED**
- Only individual search (last name ≥ 2 characters); no bulk CSV or API.
- ASP.NET WebForms session state.

### 6. Florida DBPR Architecture/Interior Design
- URL: https://www2.myfloridalicense.com/sto/file_download/extracts/lic02ai.csv
- robots.txt: `/sto/` path allowed.
- **Result: REJECTED — insufficient records**
- CSV download works, ~800–1,000 architect rows (file did not exceed 10 MB
  tool limit). Below the spirit of our 500-record floor on a category basis,
  and the existing `florida-dbpr` stub already claims this namespace.

### 7. Delaware Division of Professional Regulation — Socrata
- URL: https://data.delaware.gov/Licenses-Certifications/Professional-and-Occupational-Licensing/pjnv-eaih
- Host: `data.delaware.gov` — Socrata API
- robots.txt: `/resource/` paths ALLOWED; only `/api/odata/` and
  `/api/collocate*` are disallowed.
- **Result: SELECTED ✓**

#### Why Selected

| Criterion | Status |
|---|---|
| robots.txt allows the fetch path | ✓ `/resource/` allowed |
| No JS-only SPA | ✓ Socrata JSON API |
| ≥500 records per category | ✓ See counts below |
| No Cloudflare/CAPTCHA/login | ✓ Public Socrata endpoint |
| Maps to existing CategoryKey | ✓ Multiple keys |

#### Verified Record Counts (2026-06-15)

| License Type | CategoryKey | Count |
|---|---|---|
| Licensed Architect | arquitecto | 4,850 |
| Certificate of Authorization-Architect | arquitecto | 780 |
| Veterinarian | veterinario | 1,893 |
| Master Plumber | fontaneria | 1,965 |
| Master HVACR | hvac | 1,418 |
| Journeyperson Electrician | electricidad | 4,926 |
| Master Electrician | electricidad | 3,533 |
| Apprentice Electrician | electricidad | 4,394 |
| **Total targeted** | | **~23,759** |

Total dataset: 349,921 records across 97+ license types.

#### Implementation

- Source file: `src/sources/delaware-dpr.ts`
- Socrata utils: reuses `_socrata-utils.ts` (`fetchSocrataJson`, `socrataPick`)
- City resolution: `ensureCity()` with `country=US` + state from row
- SoQL `$where` clause pushes category filter server-side (only ~23k rows fetched)
- Default limit: 30,000 rows per run (covers all targeted types)
- Workflow: `.github/workflows/scrape-delaware-dpr.yml` (monthly, day 5)
