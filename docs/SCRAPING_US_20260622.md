# US scraper scout — 2026-06-22

## Candidate evaluated

### Washington State DOH — Dentist License (`wa-doh-dentists`)

**Source**: data.wa.gov / Socrata view `qxh8-f4bd`  
**Category**: `dentista`  
**Estimated records**: ~6,800 active Dentist Licences in WA  
**Access method**: Socrata SODA JSON API (same view and helper used by `wa-doh-psychologists`)

**Pre-flight checks:**
- `robots.txt` at `data.wa.gov` does not block `/resource/` paths — confirmed in
  `wa-doh-psychologists.ts` header and independently verified.
- No login, no Cloudflare, no captcha.  
- Live API query `?$where=CredentialType='Dentist License' AND Status='Active'`
  returns ~6,800 rows with fields: `CredentialNumber`, `LastName`, `FirstName`,
  `MiddleName`, `CredentialType`, `Status`, `ExpirationDate`, `FirstIssueDate`.
- No city/address field — province-level granularity only (`province_slug = "wa"`),
  same as the psychologists scraper.
- Dataset updated daily from a 2:00 AM snapshot.

**Decision**: BUILT — near-zero-effort fork of `wa-doh-psychologists.ts`.
Fills the WA `dentista` gap (no prior US dentist source for Washington State).

## Other candidates researched and rejected

| Source | Reason rejected |
|--------|-----------------|
| MN Board of Dentistry (bodgl.hlb.state.mn.us) | GLSuite portal returned HTTP 500; no confirmed bulk API |
| NC Board of Dental Examiners | TOS prohibits commercial use of directory data |
| OH Dental Board via eLicense | Already covered by `oh-elicense` (Ohio eLicense covers multiple boards) |
| LA State Board of Dentistry | Individual-lookup form only; no open-data endpoint |
