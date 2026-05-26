# US Scraper Expansion — 2026-05-26

## Candidates Evaluated

### 1. EOIR Accredited Representatives (extranjeria)

- **URL checked**: https://www.justice.gov/eoir/recognized-organizations-and-accredited-representatives-roster-pages
- **Alternate URL**: https://www.justice.gov/eoir/eoir-recognized-organizations
- **robots.txt**: `www.justice.gov/robots.txt` does NOT disallow `/eoir/` — path is allowed.
- **Result**: FAIL — Both URLs return 404 "Page not found." The page has been removed from the current DOJ website (Drupal 10). A note on the site says "Some files associated with previous administrations have been moved to the Archive section." The EOIR accreditation pages were part of an older site structure and are no longer available at any discoverable path.
- **Verdict**: NOT VIABLE — page does not exist at datacenter-reachable URL.

### 2. NCARB Find an Architect (arquitecto) — SELECTED

- **URL**: https://www.ncarb.org/ncarb-certificate/benefits/lookup
- **robots.txt**: `www.ncarb.org/robots.txt` — only disallows `/core/`, `/profiles/`, `/admin/`, `/search/`, `/user/*`, `/antibot`, PDF query strings, and a few specific publication redirects. `/api/` is NOT disallowed.
- **API endpoint discovered**: `/api/certifications/search` — found by inspecting the bundled JS at `/sites/default/files/js/js_MtL4fgEGj1uKcmhO26prMt4iMiErPmtZAiGYz_silQY.js` (line: `const api="/api/certifications/search"`).
- **API format**: JSON REST, GET parameters: `firstName`, `lastName`, `city`, `stateCode`, `offset`, `limit`, `orderBy`. Paginated with `pageInfo.totalItems` / `pageInfo.hasNextPage`.
- **Max limit**: 200 records per request (limit=250+ returns `{"error":"Unable to fetch certification data."}`).
- **Total records**: 51,918 NCARB-certified architects across the US (as of 2026-05-26).
- **No auth/captcha**: Accessible from datacenter IPs without cookies, tokens, or Cloudflare challenge.
- **Sample record**: `{"id":"...uuid...","firstName":"Megan","lastName":"Aasen","city":"San Francisco","stateCode":"CA","countryCode":"USA"}`
- **Category**: `arquitecto`
- **Verdict**: VIABLE — 51,918 records, JSON API, robots-OK, no login/captcha, maps to `arquitecto` taxonomy key.

### 3. AAVSB Vet-Verify (veterinario)

Not evaluated — candidate #2 passed viability check.

### 4. State dental board bulk CSV (dentista)

Not evaluated — candidate #2 passed viability check.

## Decision

Implemented scraper for NCARB certified architects (`ncarb-architects`).
- Source slug: `ncarb-architects`
- Category: `arquitecto`
- Authority: National Council of Architectural Registration Boards (NCARB)
- Records: ~51,918
- Cron: monthly (1st of month, 09:00 UTC)
