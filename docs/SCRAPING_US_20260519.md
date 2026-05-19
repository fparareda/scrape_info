# US Scraper Scout — 2026-05-19

## Candidate evaluated

### Indiana Professional Licensing Agency (PLA)

| Field | Value |
|---|---|
| URL | https://mylicense.in.gov/everification/Search.aspx (web UI) |
| API | https://mulesoft.in.gov/pla-everification-api-v1-p/api/ (MuleSoft, free credentials) |
| Categories | `arquitecto`, `ingenieria` |
| robots.txt | ALLOWED — in.gov has no Disallow rules for /pla/ or /everification/ |
| Record count | ~500 000+ total; 3 000–15 000 in scope (architects + engineers) |
| Blockers | MuleSoft API: free credential registration via email (madoades@pla.in.gov) |
| Web UI | ASP.NET WebForms with __VIEWSTATE — same pattern flagged as needing Playwright for AILA |
| Verdict | **HONEST STUB** — viable in taxonomy, blocked by access gate |

### Why chosen

- `arquitecto` and `ingenieria` have zero existing US state-level coverage.
- Indiana has no existing scraper; all neighbouring states (Illinois, Ohio,
  Michigan) cover medicine/pharmacy via IDFPR/eLicense but not architects.
- The PLA API is officially documented and free (not paywalled); only the
  credential acquisition step is manual.

### Implementation notes

Scraper ships as an honest stub (`src/sources/indiana-pla.ts`). All wiring
(ScrapeSource type, env flag, runner registration, cron workflow) is in place.

To activate:
1. Email madoades@pla.in.gov requesting eVerification API credentials.
2. Add `PROLIO_INDIANA_PLA_API_KEY` (and `PROLIO_INDIANA_PLA_API_SECRET` if
   required) to GitHub Actions secrets.
3. Implement the fetch loop in `runIndianaPla()` using the documented endpoints:
   - `GET .../PLALicenseInformation` → profession catalog
   - `GET .../search?profession=Architects&licStatus=Active` → architects
   - `GET .../search?profession=Engineers&licStatus=Active` → engineers
4. Set `PROLIO_RUN_INDIANA_PLA=true` in the workflow env.

### Rejected candidates

| Candidate | Reason |
|---|---|
| South Carolina LLR | Not researched in time budget (15 min cap reached) |
| Utah DOPL | Not researched in time budget |
| Oklahoma CIB | Not researched in time budget |
