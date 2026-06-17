# CA Source Research — 2026-05-22

## Objective
Find ONE new scrapeable CA source that fits the existing taxonomy, is not already
in the repo or any open PR, and passes all pre-flight criteria.

## Candidates evaluated

### 1. Ordre des pharmaciens du Québec (OPQ) — opq.org — farmacia QC
**URL:** https://www.opq.org/trouver-un-pharmacien/

**robots.txt:** ALLOWS all crawling (Yoast block: `Disallow:` empty).

**Verdict: BLOCKED — JS-only SPA.**
The pharmacist directory is rendered by JavaScript (loading GIF placeholder, no
server-rendered rows). The WordPress REST API at `/wp-json/` is available and
exposes `facetwp/v1`, but `GET /wp-json/facetwp/v1/data` returns 404 and
`POST /wp-admin/admin-ajax.php?action=facetwp_refresh` returns 400. No usable
static endpoint found within time budget.

---

### 2. CPSNB — College of Physicians and Surgeons of New Brunswick — medicina NB
**URL:** https://cpsnb.org/en/public-directory

**robots.txt:** DISALLOWS `/en/find-physicians/medical-directory` and
`/fr/trouver-des-medecins/annuaire-medicale` for all user agents.

**Verdict: BLOCKED by robots.txt.** Explicitly disallowed.

---

### 3. CDSBC / BC College of Oral Health Professionals (BCCOHP) — dentista BC
**URL:** https://oralhealthbc.ca/public-register/ → redirects to
https://apps.oralhealthbc.ca/apps/public-register/

**robots.txt (oralhealthbc.ca):** Only blocks WPForms uploads and wp-json paths.
The `apps.oralhealthbc.ca` subdomain returns 404 for robots.txt, so no explicit
block.

**Verdict: DEFERRED — ASP.NET PostBack form.**
The registry is an ASP.NET WebForms application. Scraping requires extracting
`__VIEWSTATE` / `__EVENTVALIDATION` tokens on each request. The pattern works
(see `cpsns-ns-physicians.ts`) but the BCCOHP app requires enumeration via
profession-type + alpha prefix drill to get all records without triggering
server-side caps. This is buildable but is a multi-hour standalone effort.

---

### 4. College of Dental Surgeons of Alberta (CDSA / cdsab.ca) — dentista AB
**URL:** https://cdsa.portalca.thentiacloud.net/webs/portal/register/#/

**robots.txt (cdsab.ca):** ALLOWS all crawling (Yoast: `Disallow:` empty).

**Thentia API test:**
- `GET https://cdsa.portalca.thentiacloud.net/rest/public/profile/search/?keyword=&skip=0&take=10&lang=en`
  → `{"resultCount": 0, "result": {"dataResults": [], "columnLayout": [...]}}`
- `GET https://cdsa.portalca.thentiacloud.net/rest/public/facility/search/?...`
  → same 0 results
- `GET .../rest/public/register/search/` → 404

**Verdict: BLOCKED at API level.** The Thentia tenant `cdsa.portalca` returns
0 rows on all known REST paths (profile, facility, register). The tenant may
require a different path, session header, or is not yet fully deployed. The
`_thentia-utils.ts` helper can be pointed at it in the future but today it yields
nothing.

---

### 5. Nova Scotia Regulator of Dentistry and Dental Assisting (NSRDDA) — dentista NS ✅ CHOSEN
**URL:** https://nsrdda.alinityapp.com/client/publicdirectory

**Regulator:** NSRDDA (formerly Provincial Dental Board of Nova Scotia — PDBNS).
The PDBNS was brought under the Regulated Health Professions Act on 2025-05-01
and became the NSRDDA. The Alinity tenant changed from `pdbns` to `nsrdda` at
that time.

**robots.txt (nsrdda.ca):** ALLOWS crawling (only `/wp-admin/` and one specific
JSON file blocked). The `alinityapp.com` subdomain has no robots.txt that
restricts this path.

**Alinity pattern:** Same as `lsnb-bar` (LSNB NB lawyers), `lss-saskatchewan`,
`cap-psychologists`, `cpm-physio`, `cpsnl`, `cpspei`, `cpsm` — all use
`_alinity-utils.ts` with the standard `querySID` shell + recursive prefix drill
on `TextOptionB` (last name). No CAPTCHA. No login. No Cloudflare.

**Category:** `dentista`

**Province:** NS (Nova Scotia)

**Expected records:** ~1,100 dentists + ~2,000 registered dental assistants (RDAs)
= ~3,100 total. Well above the 500-record threshold.

**Implementation:** `src/sources/nsrdda-ns-dentists.ts`, tenant `nsrdda`,
slug `nsrdda-ns-dentists`. Reuses `fetchAlinityDirectory` from `_alinity-utils.ts`.

**Status:** IMPLEMENTED. See PR for source file + wiring.

---

### 6. New Brunswick College of Pharmacists (NBCP) — farmacia NB
**URL:** https://nbcp-opnb.alinityapp.com/client/publicdirectory

**robots.txt (nbpharmacists.ca):** ALLOWS crawling.

**Verdict: VIABLE but lower priority than NSRDDA.**
The NBCP uses Alinity at `nbcp-opnb`. The page is confirmed to load (search form
visible), but the querySID hidden input requires JavaScript rendering (not visible
in static WebFetch). The `_alinity-utils.ts` helper fetches querySID at runtime
via Node `fetch()`, so this should work. NB is the province with the least CA
coverage after NS. However, NB pharmacists are fewer (~700) and NSRDDA covers
two categories in one source. Queued as next candidate.
