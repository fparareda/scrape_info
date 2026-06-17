# CA Scraper Scout — 2026-06-13

## Selected source: cphm-mb-pharmacists

**Authority:** College of Pharmacists of Manitoba (CPhM)  
**URL:** https://cphm.alinityapp.com/Client/PublicDirectory  
**Category:** farmacia  
**Province:** Manitoba (MB)  
**Estimated records:** ~3,100 (pharmacists + pharmacy technicians)

### Viability assessment

| Check | Result |
|-------|--------|
| robots.txt | Allowed (Disallow: with no paths; crawl-delay: 10s) |
| Auth required | No |
| Cloudflare/CAPTCHA | No |
| JS-only SPA | No — Alinity server-side; querySID discoverable from HTML |
| Pagination | Alinity prefix enumeration (existing `_alinity-utils` helper) |
| Record count | ~3,100 |

### Candidates investigated

1. **PEO Ontario (peo.on.ca/directory)** — 403 Forbidden on fetch; Drupal-powered but the directory search path returns 403 to automated requests. Not viable without residential IP.

2. **CPSS Saskatchewan (cps.sk.ca/imis/PhysicianSearch)** — 403 Forbidden; iMIS-based portal blocks datacenter IPs. Not viable.

3. **CPhM Manitoba (cphm.alinityapp.com)** — SELECTED. Alinity tenant `cphm`. robots.txt at cphm.ca allows all paths (no Disallow). The public directory uses the same Alinity infrastructure as existing sources (mvma-mb-vets, cpspei, cap-psychologists, lsnb-bar, etc.). The `_alinity-utils` helper handles prefix enumeration transparently.

### Implementation notes

- Slug: `cphm-mb-pharmacists`
- Env flag: `PROLIO_RUN_CPHM_MB_PHARMACISTS=true`
- Both Pharmacists and Pharmacy Technicians are included under `farmacia`
- City fallback: `winnipeg` (covers ~60% of MB pharmacy professionals)
- Request delay: 1,000ms (within robots.txt crawl-delay of 10s)
- Monthly cron: day 2 at 04:00 UTC
