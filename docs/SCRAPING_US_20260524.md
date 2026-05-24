# US Scraper Pre-flight — 2026-05-24

## Objective

Fill the **fiscal** (tax advisors, CPAs, accountants) category gap for the US.
Secondary objective: evaluate **cerrajero** (locksmith) and **veterinario** (national vet) gaps.

---

## Candidates Investigated

### 1. IRS Enrolled Agent FOIA Bulk CSV — **SELECTED**

- **URL**: `https://www.irs.gov/pub/foia/active-ea-foia-listing-march-2026.csv`
- **robots.txt**: `/pub/` path not in any Disallow rule on irs.gov → **permitted**
- **Auth / CAPTCHA**: None — plain HTTP GET, `content-type: text/csv`, HTTP 200
- **Format**: Single national CSV, ~154k total records (69k US, 85k international)
- **Fields**: `First Name, Middle Name, Last Name, Address Line 1, Address Line 2, Address Line 3, City, State, Zip, Country`
- **Update cadence**: Bi-annually (March 26, 2026 was most recent)
- **Category**: `fiscal`
- **Notes**: Distinct from IRS PTIN FOIA (PR #11) which covers all PTIN holders
  (CPAs, EAs, attorneys, unenrolled) via per-state files. The EA FOIA is a single
  national file specifically listing Enrolled Agents — a distinct federal credential
  (federal license to represent taxpayers before the IRS). Different schema, different
  URL, complementary record set.
- **Verdict**: **VIABLE — selected**

### 2. NASBA CPAverify / ALD (ald.nasba.org)

- **robots.txt**: `Disallow: /api/*` and `Disallow: /ald-search/*` — **BLOCKED**
- Individual lookups require jurisdiction + last name; no bulk export
- **Verdict**: NOT VIABLE (robots.txt disallows API)

### 3. IRS RPO Preparer Directory (irs.treasury.gov/rpo/rpo.jsf)

- Timed out on fetch (Akamai/CDN); JSF stateful session required
- No bulk download documented; search-by-ZIP only
- **Verdict**: NOT VIABLE (no bulk endpoint)

### 4. Washington State CPA Open Data (data.wa.gov `6du3-3h9e`)

- Socrata API: `https://data.wa.gov/resource/6du3-3h9e.json`
- 50,672 records, good fields (firstname, lastname, city, state, number, status, expires)
- Accessible without auth, no CAPTCHA
- **Limitation**: Washington state only — not national
- **Verdict**: Viable as supplementary; deferred (national EA FOIA is a better first step)

### 5. Locksmith (cerrajero) sources

Only ~13 US states require locksmith licensing. Evaluated:
- **NJ DCA Fire Alarm/Burglar Alarm/Locksmith** (njconsumeraffairs.gov): behind Incapsula WAF → NOT VIABLE
- **NC Locksmith Licensing Board** (nclocksmithboard.org): WordPress + admin-ajax with session nonces → NOT VIABLE
- **USDA APHIS VetSearch** (vsapps.aphis.usda.gov): requires state + county selection; iterating ~3,000 counties is impractical → NOT VIABLE (already stubbed in usda-aphis-vets.ts)
- **Oregon CCB** (already covered) does not include locksmith licenses
- **Virginia DPOR** (already covered) does not include locksmith licenses

Cerrajero: existing OSM (PR #66) + Illinois IDFPR + Louisiana LSLBC + NY DOS provide meaningful coverage already.

### 6. National veterinary data

- **NPI** already covers veterinarians via taxonomy code `174M` (npi.ts)
- **CA DCA open-data** already covers California Veterinary Medical Board
- **USDA APHIS**: stubbed in `usda-aphis-vets.ts` — unreachable from cloud egress (probed 2026-05-18)
- No new viable national vet source found without residential proxy

---

## Decision

Implement **irs-ea-foia** — IRS Enrolled Agent FOIA bulk CSV for `fiscal` (US).

Slug: `irs-ea-foia`
Source key: `"irs-ea-foia"` in `ScrapeSource`
Env flag: `PROLIO_RUN_IRS_EA_FOIA=true`
Limit env: `PROLIO_IRS_EA_FOIA_LIMIT` (default 10 000)
URL override: `PROLIO_IRS_EA_FOIA_CSV`
