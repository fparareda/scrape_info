# US Scraper Preflight — 2026-06-01

## Chosen Source: Oklahoma State Board of Examiners of Psychologists (OSBEP)

### Summary

| Field              | Value                                                      |
|--------------------|------------------------------------------------------------|
| Slug               | `ok-osbep-psychologists`                                   |
| CategoryKey        | `psicologia`                                               |
| URL                | https://pay.apps.ok.gov/OSBEP/_app/search/index.php        |
| Access method      | HTTP POST, `application/x-www-form-urlencoded`             |
| Response format    | Plain HTML table (no JS-only SPA)                          |
| Record count est.  | ~1,200 total (611 active, 1,203 all statuses)              |
| robots.txt         | 404 (no restrictions) on `pay.apps.ok.gov`                 |
| Cloudflare/WAF     | None detected                                              |
| CAPTCHA            | None detected                                              |
| Authentication     | None required for public search                            |
| Update frequency   | Annual licensing cycle; monthly cron sufficient            |

### robots.txt Verification

`https://pay.apps.ok.gov/robots.txt` returns HTTP 404. No restrictions apply.
The parent domain `https://oklahoma.gov/robots.txt` has no disallow rules for `/OSBEP/`.

### Access Method

Submit a POST form to `https://pay.apps.ok.gov/OSBEP/_app/search/index.php` with these fields:

```
LAST_NAME=
FIRST_NAME=
CITY=
STATE=
ZIP=
LICENSE_NUM=
STATUS_ID=   (blank = all statuses; 1 = Active)
ISSUEDATE_FROM=
ISSUEDATE_TO=
button=Search
```

All results are returned in a single HTML `<table id="psychologists">`. No pagination.

### HTML Table Structure

Columns (in order): Last Name | First Name | City | State | ZIP | Phone | License # | Status | Issue Date | Specialty

Example row:
```
Abbott | Catharine | Oklahoma City | OK | 73142 | (405) 249-4440 | 529 | Active | 09/24/1988 | Counseling
```

### Record Count Verification (2026-06-01)

- Active status only: 611 records
- All statuses: 1,203 records (Active + Inactive + Expired + Revoked etc.)

Both exceed the 500-record minimum threshold.

### Rejected Alternatives

1. **WV Board of Examiners of Psychologists** (psychbd.wv.gov)
   - License search results page uses JavaScript ("Loading..." placeholder)
   - PDF roster available but PDF parsing not trivially implemented
   - Too small: WV has ~400-500 psychologists

2. **SC Board of Examiners in Psychology** (llr.sc.gov → verify.llronline.com)
   - Redirects exceeded limit (10+ redirects) when accessing the lookup tool
   - Access to search results was not verified

3. **Oklahoma psychology board** was selected over WV/SC because:
   - Plain HTML response, single POST request, no JS required
   - Blank search returns all records in one page
   - No robots.txt restrictions
   - No Cloudflare/WAF
   - 1,200+ records well above minimum threshold
