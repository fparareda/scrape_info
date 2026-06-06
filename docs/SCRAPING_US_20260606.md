# US Scraper Expansion — 2026-06-06

## Candidates Researched

### 1. Connecticut eLicense — Socrata Open Data ✅ PICKED

**Dataset:** State Licenses and Credentials (`ngch-56tr`)

**URL:** https://data.ct.gov/Business/State-Licenses-and-Credentials/ngch-56tr

**API endpoint:** `https://data.ct.gov/resource/ngch-56tr.json`

**robots.txt:** ALLOWED. portal.ct.gov blocks only Sitecore admin paths and named
bots (AhrefsBot, SEMrush); no restrictions on data.ct.gov Socrata API paths.

**Technology:** Socrata open-data platform. Full REST API with SoQL filtering,
CSV/JSON bulk download. Updated daily. No auth required.

**Record count:** ~2 million rows total. Filtered subset (active trade/contractor
licenses) ~50k–200k rows.

**Fields available:**
- `credential_identifier` — unique row ID
- `licensee_name` / `business_name` / `dba_name`
- `credential_type` — license type (850+ types including electricians, plumbers,
  HVAC/heating, home improvement, engineers, architects, and more)
- `credential_number` — licence number
- `credential_status` — Active / Expired / etc.
- `office_address` — street address
- `office_city` / `office_state` / `office_zip`
- `issued_date` / `expiration_date`

**CategoryKey mapping (keyword-based on credential_type):**
- Electrical/Electrician → `electricidad`
- Plumbing/Plumber → `fontaneria`
- Heating/HVAC/Air Conditioning/Refrigeration → `hvac`
- Home Improvement/General Contractor/Builder/Carpenter → `carpinteria`
- Engineer/Engineering → `ingenieria`
- Architect/Architecture → `arquitecto`

**State covered:** Connecticut (CT) — currently a gap state (no CT source exists).

**Scraper slug:** `data-gov-ct-elicense`
**Source file:** `src/sources/data-gov-ct-elicense.ts`
**Cron:** Monthly (3rd of month 04:00 UTC) — CT credential records update daily
but annual cadence is sufficient for directory quality.

---

### 2. Utah DOPL — Blocked by cost

Paid data request service ($150 base fee). Skipped.

### 3. Indiana PLA — Blocked by cost

Paid ($150 + $10/1k records). Skipped.

### 4. South Carolina LLR — Login wall

Bulk access requires authentication. Skipped.

### 5. ALOA Locksmiths — 404 / login-gated

find-a-locksmith page returns 404; member directory appears login-gated. Skipped.

### 6. ACCA HVAC — Viable but small (~3,000 records)

robots.txt allows; HTML scraping by zip code; ~3,000 member businesses.
Deprioritized vs CT eLicense (membership-only, not comprehensive licensing data).
