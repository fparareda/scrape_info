# US Scraper Expansion — 2026-06-13

## Selected Source: ca-dir-ecu-electricians

**Dataset:** California DIR Electrician Certification Unit (ECU)
**URL:** https://data.ca.gov/dataset/dir-electrician-certification-unit-ecu
**Agency:** CA Department of Industrial Relations (DIR), DLSE / ECU
**Category:** `electricidad`
**Country:** US
**State:** CA (primarily; minority of licensees hold out-of-state zip codes)

### Data Volume
- Certified Electrician List: ~36,427 rows
- Electrician Trainee List:   ~19,364 rows
- **Total: ~55,791 rows**

### Data Fields
`ELECTRICIAN_NAME | ZIP_CODE | CERTIFICATE_NUMBER | EXPIRATION_DATE`

### Access Method
Direct CSV download from data.ca.gov which redirects to a pre-signed S3 URL.
Two CSV files:
1. `certified_electrician_list.csv`
2. `electrician_trainee_list.csv`

Update cadence: biweekly (confirmed last updated 2026-06-12).

### robots.txt Assessment (data.ca.gov, 2026-06-13)
- `Disallow: /api/` — blocks CKAN datastore API
- `Disallow: /contact`, locale dirs, etc.
- `/dataset/.../download/...` path is NOT disallowed
- The S3 CDN host (s3.amazonaws.com) has no applicable robots.txt
- **Verdict: ALLOWED** — we download the CSV file, not the API

### robots.txt Assessment (www.dir.ca.gov, 2026-06-13)
- `Disallow: /*.htm/`, `Disallow: /*.html/`, some scripts/styles dirs
- `/dlse/ecu/` is NOT mentioned
- We do not scrape dir.ca.gov at all — only data.ca.gov CSVs
- **Verdict: N/A** (not crawled)

### Why Not Already Covered
The existing `ca-dca-open-data` source covers California DCA (Department of
Consumer Affairs) boards — 35 separate professional boards. The ECU is under
the DIR (Department of Industrial Relations), a completely separate agency.
Certified electricians are NOT in any existing source.

### City Resolution
The dataset only provides ZIP codes, not city names. City names are resolved
via Nominatim's US postalcode lookup (`postalcode=NNNNN&countrycodes=us`).
Results are cached per unique zip to respect Nominatim's 1 req/s policy.
Rows with unresolvable zips are dropped with a warning log.

Expected geocoding success rate: ~95%+ (most CA zip codes geocode cleanly).

### Candidates Investigated and Rejected

| Source | Reason Rejected |
|--------|----------------|
| SC LLR (South Carolina) | Bulk verification requires account login; no public CSV |
| Utah DOPL | CBR only covers opt-in licensees; no public bulk download |
| Indiana PLA | Paid download ($150 + $10/1k records) |
| Hawaii PVL (opendata.hawaii.gov) | Only an HTML search page, no CSV/API |
| Alabama Board of Electrical Contractors | Interactive search only, no bulk download |
| Arkansas Contractors (aclb2.arkansas.gov) | Site unreachable during investigation (timeout) |
| Oregon CCB (data.oregon.gov/g77e-6bhs) | Already covered by `oregon-ccb` source |
| Kansas | No open data portal found for contractor licensing |
| Idaho | No Socrata or open data portal for licensing found |

## Slug: `ca-dir-ecu-electricians`
## Env Flag: `PROLIO_RUN_CA_DIR_ECU_ELECTRICIANS=true`
## Cron: Monthly (3rd of month, 05:00 UTC)
