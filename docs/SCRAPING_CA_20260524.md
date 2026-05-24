# CA Scraping Research — 2026-05-24

## Objective

Identify viable new CA scraper sources for the `fiscal` (CPAs/accountants),
`dentista` (BC/AB dental colleges), and `arquitecto` (BC/AB architects)
category gaps.

---

## Candidates Investigated

### 1. CPA Ontario — `cpaontario.ca` (fiscal)

- **Robots.txt**: Allow all (only `/error/404` and a PDF viewer blocked).
- **Registry URL**: `https://www.cpaontario.ca/protecting-the-public/directories/member`
  → HTTP 403. Also tried `portal2.cpaontario.ca/york/Public/Member_Directory.aspx`
  → silent timeout on all requests.
- **Verdict**: BLOCKED. CPA Ontario's member directory returns 403 from datacenter
  IPs on both the main site and the legacy portal2 subdomain. The newer myportal
  subdomain (`myportal.cpaontario.ca`) redirects to cpaontario.ca. Not viable
  without residential IP / Playwright.

### 2. CPABC — `services.bccpa.ca` (fiscal)

- **Robots.txt**: Allows all (no explicit disallows for the directory path);
  crawl-delay: 60.
- **User Agreement**: Explicitly states "These directories and their contents are
  the property of CPABC, and **must not be used for any commercial, marketing,
  or fundraising purposes.**"
- **Verdict**: DISQUALIFIED by ToU. The commercial-use prohibition is explicit.

### 3. CPA Manitoba — `cpamb.ca` (fiscal)

- **Robots.txt**: 403 on first check.
- **Terms**: "directory and its contents are the property of CPA Manitoba, and
  **may not be copied, redistributed or altered in any manner, nor may it be
  used for commercial or solicitation purposes.**"
- **Verdict**: DISQUALIFIED by ToU.

### 4. CPA Quebec — `cpaquebec.ca` (fiscal)

- **Robots.txt**: Disallows `/en/search/`, `/fr/recherche/`; membership roll not
  blocked.
- **Terms**: "the creation of lists for commercial or philanthropic solicitation
  **would violate privacy rules.**"
- **General ToU**: "Users are strictly prohibited from using, selling or modifying
  the texts, images or information contained … for public or commercial purposes."
- **Verdict**: DISQUALIFIED by ToU.

### 5. College of Dental Surgeons of Alberta — `cdsab.ca` / Thentia Cloud (dentista)

- **Robots.txt**: Allows all (only `/gf-entries-in-excel/` and `/wp-admin/`
  disallowed).
- **Register URL**: `https://cdsa.portalca.thentiacloud.net/webs/portal/register/`
  (old) → `https://cdsa.ca.thentiacloud.com/v/register/` (new, migrated to v5).
- **API testing**: The old Thentia REST endpoint
  (`/rest/public/profile/search/?keyword=&skip=0&take=10`) returns HTTP 200 with
  a valid column-layout schema but consistently `resultCount: 0`. The new
  `.thentiacloud.com` domain serves HTML/CSS but REST paths return 404. The
  `custom-public-register/profile/individual/` endpoint requires a session
  init call first and then returns HTTP 400 even with valid cookies.
  Investigation of the JS bundle confirms the data API on the new tenant requires
  credentials (`/thentiacloud/1.0/search/query/` returns "Credentials are
  required to access this resource.").
- **Verdict**: NOT VIABLE. Thentia Cloud v5 tenant for CDSA has migrated to a
  private API that requires authentication. The public register is JS-only SPA
  and cannot be scraped programmatically.

### 6. AIBC — `aibc.ca` (arquitecto)

- **Robots.txt**: Allows all (only `/wp-content/uploads/files/` disallowed).
- **Register page**: Appears to be a server-rendered form. However the register
  page explicitly states: "The information is **not to be used for any
  commercial, marketing or fundraising purposes.**"
- **Verdict**: DISQUALIFIED by explicit usage restriction.

### 7. BCCOHP — `apps.oralhealthbc.ca` (dentista) ✅ VIABLE

- **Robots.txt**: 404 (no file). No restrictions.
- **Register URL**: `https://apps.oralhealthbc.ca/apps/public-register/`
  (redirected from `https://oralhealthbc.ca/public-register/`)
- **Architecture**: Classic ASP.NET WebForms. Single GET + POST pattern:
  - GET the form page → extracts `__VIEWSTATE`, `__VIEWSTATEGENERATOR`,
    `__EVENTVALIDATION` tokens.
  - POST with `ddlClass=Dentist` → returns **all 4,352 BC dentists** in a
    single ~4.1 MB HTML response (no pagination).
- **Fields available** (columns in table):
  - Name (Last, First format; optional "Preferred Name" suffix)
  - Licence Class (Full Dentist, Limited Dentist, etc.)
  - Certified Specialty (oral surgery, orthodontics, etc.)
  - Practice Location (city — present for ~85% of rows)
  - Additional Language(s)
  - No registration number in list view
- **Record counts** (as of 2026-05-24):
  - Dentists: 4,352
  - Dental Hygienists: 5,063
  - Licensed Dental Assistants: 6,488
  - Dental Technicians: 264
  - Denturists: 262
  - Dental Therapists: 4
- **Terms**: BCCOHP privacy policy is about data they collect from users, not
  about use of the public register. The public register is a statutory mandate
  under BC's Health Professions Act. No explicit commercial restriction found.
- **Verdict**: VIABLE. Implemented as `bccohp-bc-dentists`.

---

## Implementation

Source file: `src/sources/bccohp-bc-dentists.ts`

- Source name: `bccohp-bc-dentists`
- Category: `dentista`
- Province: BC
- Authority: BCCOHP
- ~4,352 active BC dentists per run
- Off by default: `PROLIO_RUN_BCCOHP_BC_DENTISTS=true`
- Cron: monthly on the 1st at 09:00 UTC

### Notes on other oral health professional types

Only `Dentist` is ingested in the initial implementation. The `dentista`
category is the correct match. The other professional types (dental hygienists,
dental assistants, technicians, denturists) would require new categories not
currently in the Prolio taxonomy. They could be added in a future PR if the
taxonomy is extended.
