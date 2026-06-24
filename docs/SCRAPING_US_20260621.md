# United States scraper scout — 2026-06-21

## Summary

**Winner**: NASBA Accountancy Licensee Database (ALD) at ald.nasba.org.
First NATIONAL CPA source for US (wa-cpa-board.ts only covered WA State).
~600k–650k records across ~48 state boards. Implemented as
`src/sources/nasba-ald-cpa-us.ts`.

## Candidates evaluated

### 1. NASBA ALD (ald.nasba.org / cpaverify.org) ✅ WINNER

- **Category**: `fiscal`
- **URL**: https://ald.nasba.org/search/cpa/results?lastName={prefix}&jurisdiction=&page={N}
  (cpaverify.org 301→ald.nasba.org/search/cpa)
- **Records**: ~600k–650k CPA records across ~48 state boards
- **robots.txt**: Disallows `/admin*`, `/ald-search/*`, `/api/*`, `/audit-log`,
  `/board/*`, `/disciplinary-records`, `/health`, `/help`,
  `/jurisdiction-management`, `/profile`, `/report/*`, `/reports/*`, `/users`.
  The path `/search/cpa/results` is NOT disallowed. ✓
- **Auth**: None. No CAPTCHA/WAF.
- **Format**: Server-rendered HTML table — NOT a JS SPA.
- **Fields**: Licensee Name, Maiden Name, Jurisdiction, License Number,
  License Status, Enforcement/Disciplinary Actions.
- **Exclusions**: Hawaii and New Mexico excluded from NASBA ALD. Firm license
  data absent for CNMI, ND, NE, NY, PA, WV, WY.
- **Enumeration**: GET with `?lastName={prefix}` for A–Z; recurse to two-letter
  prefixes when cap (250 results/query) is hit.
- **Implementation**: `src/sources/nasba-ald-cpa-us.ts`
- **Workflow**: `.github/workflows/scrape-nasba-ald-cpa-us.yml` (monthly, 8th)
- **Flag**: `PROLIO_RUN_NASBA_ALD_CPA_US=true`

### 2. ASE certified technicians (mecanica)

- **URL**: https://www.ase.com/find-a-shop
- **Verdict**: ❌ SSL CERTIFICATE ERROR — could not verify server identity on
  ase.com during pre-flight. /find-a-shop and /certifications/find-a-mechanic
  both returned SSL verification failures. Cannot confirm server-rendering or
  record count.

### 3. ALOA Find a Locksmith / findalocksmith.com (cerrajero)

- **URL**: https://findalocksmith.com
- **Verdict**: ❌ JS-DRIVEN / 404 — /locksmiths/new-york and /find-a-locksmith
  returned 404. Likely a JS map widget with no server-rendered listing.

### 4. Texas State Board of Public Accountancy (fiscal)

- **URL**: https://portal.tsbpa.texas.gov/php/fpl/indlookup.php
- **Verdict**: ❌ SUPERSEDED — Texas-only (~90k CPAs). The national NASBA ALD
  covers Texas via its TX jurisdiction filter. No need to add a redundant TX
  source when NASBA covers all states.

### 5. Florida DBPR Accountants bulk file (fiscal)

- **URL**: https://www2.myfloridalicense.com/dbpr/os/documents/AccountantsLicensees.txt
- **Verdict**: ❌ DEAD URL — redirects to homepage; file removed or path changed.

### 6. NASCLA national contractor lookup

- **URL**: https://www.nascla.org
- **Verdict**: ❌ NO DIRECTORY — robots.txt disallows /search/; no working
  contractor directory found at /page/ContractorLicenseLookup (404).

## Rationale

The US already has extensive coverage across most trade categories. The
clearest remaining gap at national scale was `fiscal`: the only existing source
was `wa-cpa-board.ts` (WA State Socrata, ~25k active WA CPAs). NASBA ALD fills
this with ~600k CPAs nationally in a single server-rendered HTML source.

wa-cpa-board.ts remains valuable: it provides Socrata-quality structured data
with expiry dates and is faster/simpler. NASBA ALD complements it with national
reach across 48 jurisdictions.
