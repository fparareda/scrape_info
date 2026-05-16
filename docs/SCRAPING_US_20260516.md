# US Scraping Research — 2026-05-16

## Candidates Evaluated

### 1. Indiana PLA — REJECTED (paywall)

- URL: https://www.in.gov/pla/license/download-license-files/
- Status: PAID — $150 for first record + $10/1,000 additional. Login/IN.gov subscription required.
- Verdict: Rejected — paywall blocks automated access.

### 2. Utah DOPL Data Request — REJECTED (paywall)

- URL: https://secure.utah.gov/datarequest/professionals/index.html
- Status: PAID — $5 minimum + $0.01–$0.03/record. Authenticated (Utah.gov subscriber).
- Utah CBR (db.dopl.utah.gov/cbr/): Free opt-in only; participation is voluntary so coverage is incomplete. No bulk download/API.
- Verdict: Rejected — paid or incomplete opt-in.

### 3. South Carolina LLR — REJECTED (no free bulk)

- URL: https://llr.sc.gov/
- LLR launched a paid "Bulk License Verification" service; no open data portal found.
- Verdict: Rejected — no free accessible API.

### 4. Connecticut eLicense — SELECTED

- Dataset: State Licenses and Credentials
- Source URL: https://data.ct.gov/Business/State-Licenses-and-Credentials/ngch-56tr/about_data
- Socrata API: https://data.ct.gov/resource/ngch-56tr.json
- Direct CSV: https://data.ct.gov/api/views/ngch-56tr/rows.csv?accessType=DOWNLOAD
- Platform: Socrata open data (government open data, no login, no captcha, no Cloudflare)
- Update frequency: Daily
- Active records: 866,855
- robots.txt: Socrata platform — explicit open API (404 on robots.txt means no disallow rules)
- Fields: credentialid, name, type, businessname, dba, fullcredentialcode, credentialtype, credentialnumber, credential, status, statusreason, active, issuedate, effectivedate, expirationdate, address, city, state, zip, recordrefreshedon
- No login required; no fee; Socrata JSON API designed for bulk programmatic access

#### Top credential types (active records):

| Credential | Count | Taxonomy |
|---|---|---|
| Registered Nurse | 77,105 | medicina |
| Home Improvement Contractor | 27,249 | carpinteria |
| Physician/Surgeon | 24,275 | medicina |
| Professional Engineer | 13,962 | ingenieria |
| Emergency Medical Technician | 13,959 | medicina |
| Hairdresser/Cosmetician | 21,639 | (skip) |
| Electrical Unlimited Journeyperson | 6,611 | electricidad |
| Electrical Unlimited Contractor | 5,632 | electricidad |
| Physical Therapist | 5,941 | fisioterapia |
| Architect | 4,903 | arquitecto |
| Heating, Piping & Cooling Journeyperson | 4,120 | hvac |
| Dental Hygienist | 3,711 | dentista |
| Dentist | 3,435 | dentista |
| Plumbing & Piping | ~2,000 | fontaneria |

#### Implementation: `src/sources/connecticut-elicense.ts`
- Source key: `connecticut-elicense`
- Env flag: `PROLIO_RUN_CONNECTICUT_ELICENSE=true`
- Fetches via Socrata JSON API with pagination (limit/offset)
- Maps credential names to CategoryKey
- Filters active records only
