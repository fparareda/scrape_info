# CA Scraper Scout — 2026-05-19

## Candidate evaluated

### College of Dental Surgeons of Saskatchewan (CDSS)

| Field | Value |
|---|---|
| URL | https://members.saskdentists.com/dentists-addresses |
| Category | `dentista` |
| robots.txt | ALLOWED — only /administrator/, /bin/, /cache/, /tmp/ blocked (Joomla system paths) |
| Record count | ~1 000–1 200 (GPs by letter A-Z + all specialists) |
| Access method | Server-rendered HTML (Joomla CMS) |
| Pagination | Alphabetical `?searchby=1&searchterm={A-Z}` for GPs; `?searchby=2` for all specialists |
| Fields | Full name, registration type, address, city, province, postal code, phone |
| Blockers | None |
| Verdict | **VIABLE** |

### Why chosen

- `dentista` has zero Canadian coverage (ODQ covers Quebec only; no AB, SK, ON,
  BC, or other provinces are represented).
- Saskatchewan CDSS is the only provincial dental regulatory body found with
  clean Joomla server-rendered HTML — the Alberta CDSAB redirects to a
  Thentia Cloud SPA, Ontario RCDSO requires session cookies, BC CDSBC is
  gated by Cloudflare.
- Fills an uncovered category × province combination: `dentista` × SK.
- Consistent with SVMA SK Vets pattern (Saskatchewan veterinary reg., same
  province, also Joomla-like WordPress server-rendered HTML).

### Implementation notes

- GPs scraped by letter (26 × ~35–60 rows); specialists in one request.
- City mapping: SK city slug table hardcoded in source (Saskatoon, Regina,
  Prince Albert, Moose Jaw, etc.); unmatched cities fall back to `saskatoon`.
- Deduplication key: `name + address` lowercase (no licence number on listing).

### Scraper

`src/sources/cdss-sk-dentists.ts`  
Env flag: `PROLIO_RUN_CDSS_SK_DENTISTS=true`  
Limit: `PROLIO_CDSS_SK_DENTISTS_LIMIT` (default 3 000)  
Workflow: `scrape-cdss-sk-dentists.yml` — monthly, day 10 06:00 UTC

### Rejected candidates

| Candidate | Reason |
|---|---|
| Alberta CDSAB | Thentia Cloud SPA — blocked |
| RCDSO Ontario | Session cookies + stateful search |
| BC College of Dental Surgeons | Cloudflare |
| Manitoba Dental Association | Not publicly enumerable |
