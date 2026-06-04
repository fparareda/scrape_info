# US Scraper Pre-flight — 2026-06-04

**Result: BUILT — `iardc-il-attorneys` (Illinois ARDC, ~97k attorneys, `abogado`)**

## Candidate evaluated

| Source | URL | Status |
|--------|-----|--------|
| **IARDC Illinois ARDC** | iardc.org/Lawyer/Search | ✅ BUILT |
| NY IARDC equivalent | iapps.courts.state.ny.us | ⛔ 403 from datacenter IPs (Akamai) |
| CPA boards (Kansas, Indiana) | ksboa.org, pla.in.gov | ⛔ JS-only SPAs / no bulk endpoint |
| Washington State Bar | wsba.org | ⛔ robots.txt Disallows member lookup |

## IARDC pre-flight findings (2026-06-04)

- **robots.txt**: `Disallow` only covers `/files/pdf/`, `/files/sampledata/`, `/bin/`,
  `/content/`, `/fonts/`, `/scripts/`, `/file/`. Path `/Lawyer/` is explicitly allowed.
- **Server**: Microsoft-IIS/10.0 / ASP.NET MVC. No Cloudflare, no CAPTCHA, no login.
- **Search flow** (two-step POST):
  1. `GET /Lawyer/Search` → session cookie + `__RequestVerificationToken` form field
  2. `POST /Lawyer/SearchResults` (LastName=A, LastNameMatch=StartsWith,
     `__RequestVerificationToken`) → PageKey GUID + result count
  3. `POST /Lawyer/SearchGrid` (PageKey + page + `__RequestVerificationToken`) →
     HTML rows: GUID, name, city, state, admitted date, status
- **Detail pages** (stateless, no auth): `/Lawyer/PrintableDetails/{GUID}?includeFormerNames=False`
  Returns: firm name, street address, city, state, ZIP, phone, email, admission date, status.
- **Record count**: ~97k total (active + inactive). Search for "Smith" (StartsWith) = 1,392.
- **Pagination**: POST-based with `page=N` parameter; 10 rows/page default.

## Implementation notes

- Category: `abogado` — Illinois attorneys, country `US`
- Enumeration: A–Z last-name `StartsWith` search, cap per run via `PROLIO_IARDC_LIMIT`
- CSRF: refresh per letter (one `GET /Lawyer/Search` before each letter's search)
- Detail pages: optional, capped by `PROLIO_IARDC_DETAILS_PER_RUN` (default 500)
- City mapping: loaded from `getCities({ country: "US" })`; only IL cities retained
- Monthly cron: bar renewals are annual; data moves slowly

## First-run checklist

On first run with `PROLIO_RUN_IARDC_IL_ATTORNEYS=true`, verify:
1. Session + CSRF token is acquired correctly (check `[iardc] letter=A total=N` log)
2. PageKey is extracted from SearchResults response (check for GUID in logs)
3. SearchGrid returns rows (if 0 rows: field names for SearchGrid POST may differ)
4. City slugs are mapping (check `droppedNoCity` equivalent in logs)

If SearchGrid returns 0 rows, inspect the actual POST field names from a browser
DevTools capture on iardc.org and update `postSearchGrid()` in the source file.
