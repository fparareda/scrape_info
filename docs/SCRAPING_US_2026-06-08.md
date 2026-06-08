# US Scraper Research — 2026-06-08

## Research Summary

Investigated five priority candidates for new US professional/contractor licensing
sources. Evaluated each against: free bulk/API access, robot.txt compliance,
record count ≥500, no captcha/login wall.

---

## Candidate 1: Indiana Professional Licensing Agency (IPLA)

**URL:** https://www.in.gov/pla/license/download-license-files/

**Verdict: REJECTED — paid download.**

Indiana IPLA offers customized CSV downloads of licensee data (name, license number,
address, issue/expiration dates, license status), but charges:
- $150 for the first record
- $10 per 1,000 additional records

No free bulk export or open-data portal found. Skipped.

---

## Candidate 2: Utah DOPL (Division of Professional Licensing)

**URL:** https://secure.utah.gov/datarequest/professionals/index.html

**Verdict: REJECTED — paid download.**

Utah DOPL offers hundreds of license types (electricians, plumbers, HVAC, contractors)
via a data request form. Pricing: minimum $5.00 fee for first 200 records; $0.03 per
additional record; $0.01/record for full list. No free direct CSV URL. Skipped.

---

## Candidate 3: South Carolina LLR Contractor Licensing Board

**URL:** https://llr.sc.gov/clb/, https://data.sc.gov

**Verdict: REJECTED — no open-data CSV found.**

SC LLR maintains a license verification portal at verify.llronline.com (updated
nightly). No bulk CSV download found on data.sc.gov or llr.sc.gov. The portal is
a search interface only. Skipped.

---

## Candidate 4: Kansas Contractor Board

**URL:** https://www.ksbtp.ks.gov/

**Verdict: REJECTED — decentralized licensing, no state-level open data.**

Kansas does not have a centralized state contractor licensing board for
electricians/plumbers. Licensing is handled at the local city/county level.
No bulk download identified. Skipped.

---

## Candidate 5: Connecticut DCP — State Licenses and Credentials

**URL:** https://data.ct.gov/Business/State-Licenses-and-Credentials/ngch-56tr

**Verdict: SELECTED.**

### Pre-flight Findings

| Check | Result |
|---|---|
| robots.txt | ALLOWED — only /OData.svc/, /api/odata/, /api/collocate* disallowed |
| Captcha / login | None |
| Cloudflare challenge | None |
| Total records | 2,641,370 |
| Active records (filtered) | ~52,000 across target categories |
| API type | Socrata JSON (`/resource/ngch-56tr.json`) |
| Daily update | Yes |

### Category Mapping (ACTIVE status only)

| Credential Type | Count | CategoryKey |
|---|---|---|
| ELECTRICAL UNLIMITED CONTRACTOR | ~5,472 | electricidad |
| ELECTRICAL LIMITED CONTRACTOR | ~(included) | electricidad |
| PLUMBING & PIPING UNLIMITED CONTRACTOR | ~2,701 | fontaneria |
| PLUMBING & PIPING LIMITED CONTRACTOR | ~(included) | fontaneria |
| HEATING, PIPING & COOLING UNLIMITED CONTRACTOR | ~2,121 | hvac |
| HEATING, PIPING & COOLING LIMITED CONTRACTOR | ~1,742 | hvac |
| HOME IMPROVEMENT CONTRACTOR | ~21,449 | carpinteria |
| NEW HOME CONSTRUCTION CONTRACTOR | ~2,733 | carpinteria |
| PROFESSIONAL ENGINEER | ~12,649 | ingenieria |
| ENGINEER-IN-TRAINING | ~1,572 | ingenieria |
| ARCHITECT / ARCHITECTURE FIRM / LANDSCAPE ARCHITECT | ~1,000 | arquitecto |

**Total estimated active records: ~52,000**

### Schema

Fields available: `credentialid`, `name`, `type` (INDIVIDUAL/LLC/etc),
`credential` (license type label), `credentialnumber`, `fullcredentialcode`,
`status`, `statusreason`, `active`, `issuedate`, `effectivedate`,
`expirationdate`, `address`, `city`, `state`, `zip`, `recordrefreshedon`.

Phone: NOT available in this dataset.

### Implementation

- Source file: `src/sources/connecticut-dcp.ts`
- Pattern: Socrata JSON pagination (`_socrata-utils.ts`), `ensureCity` for city upsert
- SoQL WHERE clause filters ACTIVE + target credential patterns server-side
- Slug: `connecticut-dcp`
- Env flag: `PROLIO_RUN_CONNECTICUT_DCP=true`
- Default limit: 60,000 rows; runner configured at 10,000 for initial runs
