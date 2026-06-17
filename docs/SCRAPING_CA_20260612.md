# CA Scraping Preflight — 2026-06-12

## CPTBC — College of Physical Therapists of BC (fisioterapia)

**Status: LIVE**

### Source

- Authority: College of Health and Care Professionals of BC (formerly CPTBC)
- URL: <https://cptbc.alinityapp.com/client/publicdirectory>
- Platform: Alinity SaaS (tenant `cptbc`)
- Category: `fisioterapia`
- Province: BC

### Pre-flight checks

| Check | Result |
|---|---|
| robots.txt | 404 (no restrictions — all paths allowed) |
| Login required | No |
| CAPTCHA | No (`EnableCaptcha: false` confirmed on probed prefixes) |
| Cloudflare / WAF | None detected |
| JS-only SPA | No — POST API endpoint accessible directly |
| Record count | ~5,407 registrants (CHCPBC 2024/25 Annual Report) |
| Data format | JSON (Alinity standard POST response) |

### Implementation

Uses `_alinity-utils.ts` `fetchAlinityDirectory()` with tenant `cptbc`.
Prefix-drilldown strategy handles the 25-row per-request cap.
City field (`hc`) is hidden in the public register; all records default
to `vancouver` (primary BC metro). Future CPTBC city data can populate
`CITY_MAP` without changing the core logic.

### Gap context

- `cpm-physio` covers Manitoba (Alinity tenant `cpm`)
- `oppq-quebec-physio` is a Cloudflare-blocked stub for Quebec
- BC physio was the last major Alinity-hosted provincial physio gap
- Ontario physio covered by `cpo-on-physio` (PR#122 open)
- Nova Scotia physio covered by `nscp-ns-physio` (PR#110 open)
- Alberta physio covered by `cpta-ab-physio` (PR#143 open)
