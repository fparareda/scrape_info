# CA scraper expansion — 2026-05-13

Research session findings for expanding Canada (CA) scraper coverage.

## Candidates evaluated

### CVO — College of Veterinarians of Ontario (veterinario)
- API: `cvo.ca.thentiacloud.net/rest/public/registrant/get/`
- **Blocked**: Returns HTTP 405 with AWS WAF captcha challenge (`x-amzn-waf-action: captcha`). Cannot bypass.

### ABVMA — Alberta Veterinary Medical Association (veterinario)
- Find-a-member URL: `/client/roster/clientRosterView.html?clientRosterId=168`
- **Blocked**: robots.txt on both `abvma.in1touch.org` and `abvma.ca` has `Disallow: /client/roster/`. Per-project rule: never scrape a disallowed path.

### CVBC — BC College of Veterinarians (veterinario)
- Tried: `/registration/registrant-directory/`, `/find-a-vet/`
- **Not viable**: Both return 404. No public registrant directory found.

### CPO — College of Physiotherapists of Ontario (fisioterapia)
- Portal: `portal.collegept.org/en-US/public-register/`
- **Not viable**: Pure PowerApps/Dynamics 365 SPA. All data fetched via JavaScript; `/_portal/entitylist/` returns no data. Cannot scrape without headless browser.

### CPTA — College of Physiotherapists of Alberta (fisioterapia)
- API: `cpta.alinityapp.com/client/PublicDirectory/Registrants` (Alinity platform)
- **Not viable**: `GetQuickSearchForm` requires login (HTTP 401). Without login-protected field IDs, cannot construct a valid search payload. All POST requests return `{"EnableCaptcha":false,"Records":[]}`.

### CPBAO — College of Physiotherapists of British Columbia (fisioterapia)
- Members subdomain: `members.cpbao.ca`
- **Not viable**: Public register search at `/public_register/create` redirects to login page. Auth required.

### OPPQ — Ordre professionnel de la physiothérapie du Québec (fisioterapia)
- Find pages: `/trouver-un-physiotherapeute/` (WordPress generic search), `/en/find-a-physiotherapist/` (404)
- **Not viable**: No public member directory accessible without form submission.

### MVMA — Manitoba Veterinary Medical Association (veterinario)
- Directory: `https://www.mvma.ca/directory/`
- robots.txt: `Disallow:` (empty) = allow all
- **Not viable**: WordPress + Contact Form 7 + invisible Google reCAPTCHA. No static member data in HTML; WP REST API has no member endpoints.

## Chosen source — RCDSO (IMPLEMENTED)

**Royal College of Dental Surgeons of Ontario** — `https://www.rcdso.org/find-a-dentist`

### robots.txt
```
User-agent: *
Allow: /
Disallow: /scripts
Disallow: /styles
```
Named AI bots (ClaudeBot, GPTBot, Google-Extended, etc.) are individually Disallow'd.
Our bot UA (`Prolio-Bot/1.0`) is NOT in the exclusion list — access is permitted.

### Mechanism
GET `/find-a-dentist/search-results?Alpha=&City=<CITY>` returns a server-rendered HTML
page with all registered dentists in that city. No pagination, no captcha, no JS required.
Only prerequisite: `Cookie: RCDSO_Language=en-ca` (language preference).

### Fields available per record
- Name
- Registration number
- Status (Member / Suspended / Voluntary Withdrawal / etc.)
- Practice name
- Street address
- Full address with city + postal code (from embedded Google Maps deep-link)
- Phone (when listed)

### Scale
Toronto alone: ~2,481 records (2,474 active Members).
Ontario-wide coverage across 30 seeded cities.

### Implementation
- Source slug: `rcdso`
- Category: `dentista`
- Province: ON
- File: `src/sources/rcdso.ts`
- Env var: `PROLIO_RUN_RCDSO=true`
- Limit var: `PROLIO_RCDSO_LIMIT` (default 10,000)
- Workflow: `.github/workflows/scrape-rcdso.yml` (weekly Sunday 09:00 UTC)
