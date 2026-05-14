# US Scraper Research — 2026-05-14

## Candidates investigated

### 1. IRS PTIN Preparer Directory (irs-ptin)

**Endpoint:** `https://www.irs.gov/pub/foia/foia-extract-consolidated.zip`
(individual state files also available at `/pub/foia/foia-<state>-extract.csv`)

**Robots.txt:** `/pub/foia/` is NOT listed in any Disallow directive on `www.irs.gov/robots.txt` — scraping permitted.

**Data format:** ZIP containing CSV per state. 16 columns confirmed from live sample:
`LAST_NAME, First_NAME, MIDDLE_NAME, SUFFIX, DBA, BUS_ADDR_LINE1, BUS_ADDR_LINE2, BUS_ADDR_LINE3, BUS_ADDR_CITY, BUS_ST_CODE, BUS_ADDR_ZIP, BUS_CNTRY_CDE, WEBSITE, BUS_PHNE_NBR, PROFESSION, AFSP_Indicator`

**Update cadence:** Bi-annually (last update Feb 23, 2026)

**Scale:** Hundreds of thousands of records across all 50 states + DC + territories (all active PTIN holders who are enrolled agents, CPAs, attorneys, and unenrolled preparers).

**PROFESSION values seen:** CPA, EA (Enrolled Agent), ATTY (Attorney), blank (unenrolled preparer)

**CategoryKey mapping:** `fiscal` — this fills the only national US `fiscal` gap in the taxonomy.

**Auth/CAPTCHA:** None — plain HTTPS ZIP download, no authentication required.

**Verdict: VIABLE. Selected as implementation target.**

---

### 2. South Carolina LLR — Contractor Licensing Board (sc-clb)

**URL:** `https://llr.sc.gov/clb/`

**Findings:** The public lookup (`verify.llronline.com`) is a search form only. There is a "LLR Bulk License Verification" link to `eservice.llr.sc.gov/OnlineVerificationBulk` but this is a batch lookup tool (submit a list of license numbers), not a bulk export. No CSV download, no open data API found.

**Verdict: NOT VIABLE** — no bulk export.

---

### 3. Indiana Professional Licensing Agency (indiana-pla)

**URL:** `https://www.in.gov/pla/`

**Findings:** The site lists an "Indiana Active Licenses Map" and "License Watch" monitoring tools, but no bulk data download or CSV export for contractor licenses (electricians, plumbers, HVAC). Only individual lookup forms are available.

**Verdict: NOT VIABLE** — no bulk export.

---

### 4. Connecticut DCP (ct-dcp)

Not investigated in detail (skipped after IRS PTIN was confirmed viable within time budget).

---

## Selected Source

**slug:** `irs-ptin`
**endpoint:** `https://www.irs.gov/pub/foia/foia-extract-consolidated.zip`
**category:** `fiscal`
**record count estimate:** 500k+ nationally
**update schedule:** bi-annually (monthly cron sufficient; data won't change more often)
