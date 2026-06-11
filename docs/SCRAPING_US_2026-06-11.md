# US scraper scout — 2026-06-11

## Summary

One viable source found: Maine ALMS Electricians' Examining Board (`electricidad`).

## Candidates evaluated

### Maine ALMS — Electricians' Examining Board — VIABLE

- **URL**: https://www.pfr.maine.gov/almsonline/almsquery/welcome.aspx?board=4220
- **Category**: `electricidad`
- **State**: Maine (ME) — not yet covered by any existing scraper
- **Record count**: ~5,000–15,000 (Master, Journeyman, Limited, Apprentice; Maine has ~3,320
  employed electricians per BLS, plus inactive and apprentice records)
- **Access**: ASP.NET WebForms, server-rendered HTML. GET welcome → session cookie; GET
  SearchIndividual.aspx → VIEWSTATE tokens; POST blank search → results page; download link
  delivers comma-delimited CSV. No CAPTCHA, no Cloudflare, no login required.
- **robots.txt**: `https://www.pfr.maine.gov/robots.txt` disallows only `/*TOKEN=`. The path
  `/almsonline/almsquery/` is unrestricted for `*`.
- **Decision**: VIABLE → implemented as `src/sources/maine-alms-electricians.ts`

### West Virginia Contractor Licensing Board — carpinteria — BLOCKED

- **URL**: https://wvclboard.wv.gov/verify/
- **robots.txt**: `Disallow: /` — all bots blocked.

### Hawaii MyPVL — multi-category — BLOCKED

- **URL**: https://mypvl.dcca.hawaii.gov/
- **robots.txt**: `Disallow: /` — all bots blocked.

### Montana DLI ebizws.mt.gov — multi-category — BLOCKED

- Returns "The requested URL was rejected" (WAF/bot detection).

### Mississippi MSBOC — carpinteria — BLOCKED

- HTTP 403 from datacenter IPs (bot detection), despite robots.txt being open.

### South Carolina LLR verify.llronline.com — multi-category — SKIP

- Session-based ASP.NET with redirect loops; not reliably accessible from server IPs.

### Kentucky DHBC ky.joportal.com — electricidad/fontaneria/hvac — UNCERTAIN

- Excel export potentially available but POST form submission unconfirmed from server IPs.

### Wyoming State Board of Architects — arquitecto — UNCERTAIN

- Data in Google Sheets (external, unstable). Record count unknown.

### Indiana PLA Download Files — multi-category — BLOCKED

- Paid service ($150+ per download).

### Arkansas Electrician Licensee Directory — electricidad — BLOCKED

- Paid ($150+). Same Indiana-style fee structure.

## Implemented

PR: `feat(scraper): maine-alms-electricians — US electricidad (ME ~10k)`
Source: `src/sources/maine-alms-electricians.ts`
Env: `PROLIO_RUN_MAINE_ALMS_ELECTRICIANS=true`
Cron: monthly (1st of month 04:30 UTC)
