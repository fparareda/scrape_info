# CA scraper scout — 2026-06-11

## Summary

One viable source found: College of Dental Surgeons of Saskatchewan (`dentista`).

## Candidates evaluated

### College of Dental Surgeons of Saskatchewan (CDSS) — dentista — VIABLE

- **URL**: https://members.saskdentists.com/dentists-addresses?searchby=1&searchterm=<LETTER>
  (iterate A–Z)
- **Category**: `dentista`
- **Province**: Saskatchewan (SK)
- **Record count**: ~700–900 dentists (26 alphabetical pages; letter B≈50, M≈47, S≈74)
- **Access**: Pure server-side HTML (Joomla). 26 GET requests — one per letter A–Z. No pagination
  within each letter page. No JS rendering, no CAPTCHA, no login.
- **robots.txt**: `members.saskdentists.com/robots.txt` disallows only Joomla system directories
  (`/administrator/`, `/bin/`, `/cache/`, `/cli/`, `/includes/`, `/installation/`, `/language/`,
  `/layouts/`, `/libraries/`, `/logs/`, `/tmp/`) and static file extensions. The path
  `/dentists-addresses` is unrestricted for `*`.
- **Fields**: full name (last, first), designation (GP / Specialist type), street address,
  city, province, postal code, phone number.
- **Decision**: VIABLE → implemented as `src/sources/cdss-sk-dentists.ts`

### Alberta College of Pharmacy (ACP) — farmacia — BLOCKED

- JavaScript SPA with no exposed API endpoint. Bulk list requires payment ($262.50).

### New Brunswick College of Pharmacists (NBCP) — farmacia — SKIP

- Alinity platform, JavaScript-driven. Same JS-SPA pattern as several existing stubs.

### College of Physiotherapists of New Brunswick (CPTNB) — fisioterapia — SKIP

- Alinity platform, JavaScript-driven.

### College of Physicians & Surgeons of Saskatchewan (CPSS) — medicina — BLOCKED

- Returns HTTP 403 on the search page; ClaudeBot explicitly blocked in robots.txt.

### Engineers Geoscientists Manitoba (APEGM) — ingenieria — BLOCKED

- Website explicitly prohibits bulk compilation/reproduction of the directory ("may not be
  compiled or reproduced in any form: printed, electronic, or otherwise").

## Implemented

PR: `feat(scraper): cdss-sk-dentists — CA dentista (SK ~800)`
Source: `src/sources/cdss-sk-dentists.ts`
Env: `PROLIO_RUN_CDSS_SK_DENTISTS=true`
Cron: monthly (1st of month 05:00 UTC)
