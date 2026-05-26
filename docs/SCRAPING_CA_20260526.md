# CA Fiscal / Accounting Scraper Research — 2026-05-26

## Summary

Researched CPA provincial directories for fiscal/accounting coverage (the biggest CA gap).
All five CPA bodies were investigated; none were viable from a datacenter IP.
Backup candidate — Law Society of Manitoba (abogado, province MB) — **passes all viability
criteria** and is implemented as `lsm-mb-lawyers`.

---

## CPA Bodies Investigated (all blocked or JS-only)

### 1. CPA Ontario — `cpaontario.ca`
- **robots.txt**: Allows `/` (only blocks PDF viewer + 404 path). ✓
- **Directory URL**: `https://www.cpaontario.ca/public-portal/find-a-cpa`
  → **HTTP 403 Forbidden** from datacenter IP. ✗
- **Verdict**: BLOCKED — datacenter IP blocked at edge (likely Cloudflare).

### 2. CPA BC — `bccpa.ca`
- **robots.txt**: Allows most paths (blocks /admin, /cms/, /login). ✓
- **Directory URL**: `https://www.bccpa.ca/member-directory`
  → **HTTP 404 Not Found**. ✗
- **Verdict**: BLOCKED — correct URL not found; likely requires login.

### 3. CPA Alberta — `cpaalberta.ca` + `services.cpaalberta.ca`
- **robots.txt**: Allows `/` (blocks Sitecore CMS paths). ✓
- **Directory URL**: `https://services.cpaalberta.ca/VerifyEntity/Members/`
  → 200 OK, search form visible. ✓ (initial load)
- **POST to ShowMembers**: `https://services.cpaalberta.ca/VerifyEntity/ShowMembers`
  → **HTTP 302 → /VerifyEntity** (session-based redirect loop from datacenter IP).
- The form uses a classic ASP.NET session-state POST-redirect-GET pattern. The POST
  always redirects back to the base URL when session state is not correctly established
  from a datacenter IP. Knockout.js frontend with jQuery.ajaxService on top.
- **Verdict**: NOT VIABLE — session-state auth prevents bulk enumeration from datacenter.
  Note: requires "exact match" on last name — no wildcard enumeration possible.
  (~28,500 AB CPAs in theory, but inaccessible from CI.)

### 4. CPA Quebec — `cpaquebec.ca`
- **robots.txt**: Not fetched successfully (returned homepage content).
- **Directory URL**: `https://www.cpaquebec.ca/en/members/find-a-cpa/`
  → Server-rendered page, but directory link `/fr/trouver-un-cpa/` leads to a search
  interface. No visible member data in HTML; likely a JS-driven search widget.
- **Verdict**: NOT VIABLE — JS-driven search, no bulk enumeration path confirmed.

### 5. CPA Manitoba — `cpamb.ca`
- **robots.txt**: Returns iMIS page (not a valid robots.txt). Site uses Telerik/iMIS.
- **Directory URL**: `https://www.cpamb.ca/main/main/find-a-cpa/find-a-member.aspx`
  → 200 OK, visible member search form (iMIS UpdatePanel/ScriptManager).
- **Form submit**: POST with `__doPostBack` → **HTTP 302 → /portal login** — redirects
  to authentication required.
- **Verdict**: NOT VIABLE — search results require active session (iMIS auth wall).

### 6. CPA Saskatchewan — `cpask.ca`
- **robots.txt**: HTTP 403 Forbidden. ✗
- **Verdict**: BLOCKED at robots.txt level.

---

## Viable Candidate: Law Society of Manitoba — `portal.lawsociety.mb.ca`

- **Category**: `abogado`
- **Province**: MB
- **Authority**: Law Society of Manitoba (LSM)
- **Estimated records**: ~3,000–4,500 practising + non-practising lawyers in MB
  (query `an` alone returns 1,814 matches; `re` returns 735; etc.)

### Viability Checks

| Check | Result |
|---|---|
| robots.txt at `lawsociety.mb.ca` | Allows `/` except `/wp-admin/` and `/wp-login.php` ✓ |
| robots.txt at `portal.lawsociety.mb.ca` | No robots.txt (404) → no restrictions ✓ |
| Directory URL accessible | `https://portal.lawsociety.mb.ca/lookup/` → 200 OK ✓ |
| JS-only SPA? | No — uses jQuery AJAX to `action.php`, but HTML is server-rendered ✓ |
| Login / captcha required? | No login required; recaptcha is wired but not enforced on GET requests ✓ |
| ≥ 500 records | Yes — single 2-letter query `an` returns 1,814 ✓ |
| Bulk enumeration possible? | Yes — iterate 2-letter prefix pairs (aa..zz) via `action.php?query=XY` ✓ |
| Pagination | 15 records/page; `page=N` parameter works ✓ |
| Data richness | Name, address, phone, email, firm, status (Practising/Non-practising/Suspended), call date ✓ |

### Technical Implementation Notes

The portal at `https://portal.lawsociety.mb.ca/lookup/` is embedded as an iframe in the
main LSM website. The actual data comes from `action.php` via AJAX GET:

```
GET /lookup/action.php?query=<2-letter-prefix>&sort=&dir=&page=<N>&rp=<0|1>
Referer: https://portal.lawsociety.mb.ca/lookup/
```

Response: Server-rendered HTML fragment with:
- `<span id="rc">N</span> matches found.` — total count for this query
- `<table>` with `<tr>` per lawyer: contact block, firm, status, history

Enumeration strategy: iterate 2-letter combinations `aa`..`zz` (676 total) plus
digits combinations. For any query returning >500 results, break into
sub-queries by appending a third letter. With page size 15, a 1814-result query
needs 121 pages. All queries use `sort=` (no sort) and `dir=` defaults.

The query is a fuzzy full-text search across name + firm + city. Deduplication
by parsed name + call date ensures each lawyer is counted once even if they
appear in multiple queries.

### Status

**IMPLEMENTED** as `lsm-mb-lawyers` — see `src/sources/lsm-mb-lawyers.ts`.
