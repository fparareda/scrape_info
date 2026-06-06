# CA Scraper Expansion — 2026-06-06

## Candidates Researched

### 1. CDSA — College of Dental Surgeons of Alberta ✅ PICKED

**URL:** https://cdsa.portalca.thentiacloud.net/webs/portal/register/#/
**Linked from:** https://cdsab.ca

**robots.txt (cdsab.ca):** ALLOWED. Only blocks Gravity Forms export plugin paths
and `/wp-admin/`. No restrictions on registrant directory paths.

**Technology:** Thentia Cloud SPA. The `_thentia-utils.ts` already knows how to
probe Thentia REST endpoints at `https://<tenant>.thentiacloud.net/`. Tenant:
`cdsa.portalca`. Known REST path candidates: `rest/public/profile/search/`,
`rest/public/register/search/`.

**Record count:** ~4,000–5,000 licensed Alberta dentists (mandatory regulatory registry
— not a voluntary association).

**Fields expected:** Name, registration number, city, registration status. Address
and phone vary by Thentia client configuration.

**CategoryKey:** `dentista`

**Gap filled:** Alberta dentists. Currently RCDSO covers Ontario, ODQ covers Quebec,
BCCOHP covers BC (via oral health portal). Alberta has no current source.

**No anti-scraping ToS found** on cdsab.ca or the Thentia portal (unlike EGBC/PEO
which have explicit prohibitions).

**Scraper slug:** `cdsa-ab-dentists`
**Source file:** `src/sources/cdsa-ab-dentists.ts`
**Cron:** Monthly (2nd of month 03:00 UTC) — dental rolls update annually.

---

### 2. BCCOHP / CDSBC (BC Dentists) — 403 block

apps.oralhealthbc.ca returns 403 to automated fetchers (likely browser-detection
or HSTS redirect). Skipped for now; may work from residential IP.

### 3. ABDA (Alberta Dental Association) — Voluntary / connection refused

Voluntary membership directory, not a regulatory registry. Site unreachable via
automated fetch. Skipped.

### 4. CVBC (BC Veterinarians) — Viable second choice

robots.txt clean. ~2,170 records. HTML form search. Address/phone per record
uncertain. Good backup if CDSA proves difficult.

### 5. EGBC (Engineers BC) — Explicit anti-scraping ToS

ToS explicitly prohibits scraping. Skipped.

### 6. PEO (Engineers Ontario) — Restricted ToS + 403

ToS restricts reproduction/distribution. Site blocks automated fetchers. Skipped.

### 7. ACP (Alberta College of Pharmacy) — Borderline

Rich fields but disclaimer restricts use to "public verification, not research or
marketing". Underlying search API endpoint not exposed in page source. Deprioritized.

### 8. CPTBC (BC Physiotherapy) — Domain in transition

Domain transition to CHCPBC (merger 2026); TLS cert errors. Field coverage appears
thin (name + status only via Alinity default template). Skipped.
