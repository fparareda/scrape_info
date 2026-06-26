# US Scraping Scout — 2026-06-26

## Candidates researched

### 1. Texas Notary Public Commissions ✅ PICKED

- **URL**: https://data.texas.gov/resource/gmd3-bnrd.json (Socrata)
- **Category**: `notario`
- **Records**: ~558,898 active commissions (Dec 2025)
- **Authority**: Texas Secretary of State
- **robots.txt**: `/resource/` path unrestricted; crawl-delay 1 s
- **Auth**: none
- **WAF**: none observed
- **Fields**: notary_id · first_name · last_name · address · city · state · zip · email_address · effective_date · expire_date · surety_company
- **Why new**: First US `notario` source — all prior notario scrapers cover ES, MX, CA/BC
- **Source slug**: `tx-notary-public`
- **Cron**: monthly (annual-cadence data)

### Secondary candidates noted (not implemented)

- **NY Notaries** (data.ny.gov/resource/rwbv-mz6z): ~231,602 records; lacks street addresses (county only). Skip for now.
- **NJ Notaries** (nj.gov flat file): ~149,276 records; limited fields. Skip for now.

## Rejected candidates

- **Locksmith registries**: No national US locksmith licensing board found; state-level boards are mostly JS-SPA or CAPTCHA-gated.
- **NIPR insurance producers**: Multi-state database but requires subscription; not freely scrapeable.
- **HVAC state boards**: Most are either covered by existing state contractor scrapers or JS-heavy portals.

## Open PRs at time of research

- PR 180: wa-doh-dentists → dentista (Washington)
- PR 178: nasba-ald-cpa-us → fiscal (CPA licensing)
