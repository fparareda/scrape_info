# CA Scraping Pre-flight — 2026-05-25

## Goal
Find one new scrapeable source for Canada within the existing CategoryKey taxonomy.

## Taxonomy gap targeted
`veterinario` BC — British Columbia veterinary practices. CVO ON, MVMA MB, ABVMA AB, and
SVMA SK are already wired; BC was the remaining gap.

## Candidates evaluated

### ✅ WINNER — CVBC Facility/Practice Registry

| Field | Value |
|---|---|
| **Source** | College of Veterinarians of British Columbia (CVBC) |
| **URL** | https://www.cvbc.ca/search-by-facility/ |
| **Category** | `veterinario` |
| **Estimated records** | ~670 active (from ~750 total, after filtering "Cancelled"/"CLOSED") |
| **Data format** | Server-rendered HTML table (single GET request, no pagination) |
| **robots.txt** | Only disallows `/wp-admin/` — `/search-by-facility/` is allowed |
| **Auth/captcha** | None |

**Columns:** Facility Name | City | Designated Veterinarian | Phone | Postal Code | Accreditation Status

**Note:** No registration number exposed in the facility table. `sourceId` built from
`cvbc:<slugified-name>-<postal-code>` — a stable composite key for the practice's lifetime.

### ❌ OMVQ (Ordre des médecins vétérinaires du Québec)
- **URL:** https://omvq.connexence.com/ext/omvq/tm/repertoire/trouverMembre.zul
- **Reason:** JS-only SPA (ZK Framework) — renders "Chargement..." with full AJAX dependency; no server-rendered results.

### ❌ AIBC (Architectural Institute of BC)
- **URL:** https://aibc.ca/members/
- **Reason:** Requires login (AIBCRegister authentication) to view member data.

### ❌ ACP (Alberta College of Pharmacy)
- **URL:** https://pharmacists.ab.ca/find-pharmacist-pharmacy/
- **Reason:** Consistent timeout on fetch — likely Cloudflare/WAF protection.

### ❌ EGBC (Engineers and Geoscientists BC)
- **URL:** https://www.egbc.ca/Find-an-Engineer-Geoscientist
- **Reason:** HTTP 403 Forbidden on all fetch attempts.

### ❌ VSA BC Motor Vehicle Directory
- **URL:** https://www.mvsabc.com/vsa-search/
- **Reason:** Power Apps portal, full JS dependency; returns "You're offline" without JS.

### ❌ APEGS (SK Engineers and Geoscientists)
- **URL:** https://register.apegs.ca/
- **Reason:** Sub-paths return 404; root has a JS-driven search form.

### ❌ CPTA (College of Physiotherapists of Alberta)
- **URL:** https://cpta.alinityapp.com/client/publicdirectory
- **Reason:** Alinity app uses template placeholders ([[ ]]) — client-side rendering, limited to 25 per search.

## Implementation

**Slug:** `cvbc-bc-vets`  
**Source file:** `src/sources/cvbc-bc-vets.ts`  
**Enable flag:** `PROLIO_RUN_CVBC_BC_VETS=true`  
**Cap:** `PROLIO_CVBC_BC_VETS_LIMIT=2000`  
**Cron:** Monthly (21st of each month, 05:00 UTC) via `scrape-cvbc-bc-vets.yml`
