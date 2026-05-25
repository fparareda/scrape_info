# US Scraping Pre-flight — 2026-05-25

## Goal
Find one new scrapeable source for the United States within the existing CategoryKey taxonomy.

## Taxonomy gap targeted
`mecanica` — auto repair workshops. No US source existed at any level (state or federal).

## Candidates evaluated

### ✅ WINNER — New York State DMV Facility Registry

| Field | Value |
|---|---|
| **Source** | New York State Department of Motor Vehicles (DMV) |
| **Dataset** | Facilities Licensed by the DMV |
| **Catalogue** | https://data.ny.gov/Transportation/Facilities-Licensed-by-the-DMV/nhjr-rpi2 |
| **API endpoint** | `https://data.ny.gov/resource/nhjr-rpi2.json?business_type=RS&$limit=5000` |
| **Category** | `mecanica` |
| **Estimated records** | 18,492 (business_type=RS filter from 55,133-row full dataset) |
| **Data format** | Socrata SODA JSON API + CSV download |
| **robots.txt** | `/resource/` path not disallowed |
| **Auth/captcha** | None |
| **License** | Public domain (data.ny.gov) |

**Fields available:** `facility_number` (unique ID), `facility_name`, `owner_name`,
`street`, `city`, `state`, `zip`, `business_type`, `original_issuance_date`,
`last_renewal_date`, `expiration_date`.

**No overlap with existing sources:** `new-york-dos.ts` covers NY Department of State
professional licenses (architects, cosmetologists, engineers, etc.) — completely
separate from DMV-regulated automotive businesses.

### ❌ South Carolina LLR (llronline.com)
- **Reason:** ASP.NET paginated search only; no bulk CSV or open-data export found.

### ❌ Utah DOPL data request
- **Reason:** Requires subscriber registration, charges $0.01/record.

### ❌ New Mexico RLD (nmrldlpi.my.site.com)
- **Reason:** Salesforce Experience Cloud SPA, HTTP 403.

### ❌ Federal auto repair registry (NHTSA)
- **Reason:** Does not exist — auto repair shop licensing is state-administered.

### ❌ Connecticut Licensed Automobile Dealers (data.ct.gov)
- **Reason:** Only 138 rows, all MANUFACTURER LICENSE (not repair shops).

### ❌ Oklahoma CIB (license.cib.ok.gov)
- **Reason:** Server unreachable (ECONNREFUSED).

## Implementation

**Slug:** `ny-dmv-repair-shops`  
**Source file:** `src/sources/ny-dmv-repair-shops.ts`  
**Enable flag:** `PROLIO_RUN_NY_DMV_REPAIR_SHOPS=true`  
**Cap:** `PROLIO_NY_DMV_REPAIR_SHOPS_LIMIT=20000`  
**Cron:** Monthly (14th of each month, 05:00 UTC) via `scrape-ny-dmv-repair-shops.yml`
