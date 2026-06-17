# Scraping Candidate — Florida DBPR Board of Veterinary Medicine

**Date:** 2026-06-12
**Country:** US
**Category:** veterinario
**Source slug:** florida-dbpr-vets

## Summary

The Florida Department of Business and Professional Regulation (DBPR) publishes
monthly bulk CSV extracts for each licensing board through its State Technology
Office (STO) file-download area.  Board 26 / license type `VM` is the Board of
Veterinary Medicine.

## Pre-flight checks

| Check | Result |
|---|---|
| URL | `https://www2.myfloridalicense.com/sto/file_download/extracts/lic26vt.csv` |
| HTTP status | 200 |
| Content-Type | text/csv |
| File size | ~2.9 MB |
| Login required | No |
| CAPTCHA | No |
| Cloudflare challenge | No (CDN only — `__cf_bm` bot management cookie set, plain 200 from datacenter IP, no JS challenge) |
| robots.txt | Disallow list does NOT include `/sto/file_download/` — confirmed allowed |
| Record count | ~14,600 rows (VM active + inactive + delinquent) |
| Refresh cadence | Monthly |

## CSV format

No header row.  22 comma-separated quoted columns:

| Col | Name | Example |
|---|---|---|
| 0 | Board code | `26` |
| 1 | License type | `VM`, `VT`, `VC` |
| 2 | Name (LAST, FIRST MIDDLE) | `SMITH, JOHN A` |
| 3 | Business name | `HAPPYPAWS ANIMAL CLINIC` |
| 4 | Address aux | |
| 5 | Street | `123 MAIN ST` |
| 6–7 | Address continuation | |
| 8 | City | `MIAMI` |
| 9 | State | `FL` |
| 10 | ZIP | `33101` |
| 11 | County code | `086` |
| 12 | License number (no prefix) | `0003487` |
| 13 | License class | |
| 14 | Status | `A`=Active, `I`=Inactive, `D`=Delinquent, `C`=Cancelled, `R`=Revoked |
| 15 | Original license date | |
| 16 | Renewal/status date | |
| 17 | Expiration date | |
| 18–19 | (spare) | |
| 20 | Full license number | `VM3487` |
| 21 | Notes | `CE Exempt` |

## Existing FL sources — why no overlap

- `florida-dbpr` (stub): covers only construction/trades via `wl11.asp`
  (session-bound ASP form requiring Playwright — not automatable as bulk).
- `fl-doh-mqa`: covers FL Department of **Health** professions (MD, dentist,
  nurse, PT, psychologist, pharmacist, …).  Veterinarians are licensed by
  **DBPR** (not DOH) and are absent from that registry.

## Ingest decisions

- Include only `VM` (licensed veterinarians) — skip `VT` (vet techs) and `VC`.
- Include only FL state addresses (column 9 = `FL`) for meaningful city slugs.
- Include statuses A, I, D; exclude C (Cancelled) and R (Revoked).
- City mapped via FL city slug table; rows without a matching FL city are skipped.
- Name reordered from `LAST, FIRST` → `FIRST LAST`.
- `sourceId` = `florida-dbpr-vets:<fullLicenseNumber>` (e.g., `florida-dbpr-vets:VM3487`).

## Enable

```bash
PROLIO_RUN_FLORIDA_DBPR_VETS=true
PROLIO_FLORIDA_DBPR_VETS_LIMIT=20000   # optional cap
```
