# CA Scraping Preflight — 2026-05-17

## Candidates researched

### 1. EGBC — Engineers and Geoscientists British Columbia
- URL: https://www.egbc.ca
- Verdict: **BLOCKED** — returns HTTP 403 on all member directory paths from datacenter IPs.

### 2. PEO — Professional Engineers Ontario
- URL: https://peo.on.ca/find-a-professional-engineer
- Verdict: **BLOCKED** — returns HTTP 403 from datacenter IPs.

### 3. OIQ — Ordre des ingénieurs du Québec
- URL: https://www.oiq.qc.ca
- Verdict: **BLOCKED** — member search requires form interaction with JS enhancement.

### 4. MAA — Manitoba Association of Architects ✅ PICKED
- URL: https://www.mbarchitects.org/find-a-member?last_name={letter}
- robots.txt: `User-agent: * / Allow: /` — fully open, no Disallow rules.
- Data format: static server-rendered HTML, no JS rendering, no login, no captcha.
- Record count: ~700–800 members across all membership classes.
- Fields: name, membership class, firm, address, city, province, postal code, phone, email.
- Category: `arquitecto` — Manitoba architects not yet covered (only OAA Ontario exists).
- Note: Members may reside in any Canadian province; full CA city index used.

## Decision

MAA is implemented as `maa-architects`. EGBC, PEO, and OIQ are skipped due to
datacenter IP blocks or JS-gated search forms; reserved for a future
Playwright/residential-proxy adapter.
