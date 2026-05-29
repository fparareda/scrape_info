# US Scraper Research — 2026-05-29

## Chosen Source: Delaware DPR (de-dpr)

| Field | Value |
|-------|-------|
| Source name | `de-dpr` |
| Human name | Delaware Division of Professional Regulation |
| URL | https://data.delaware.gov/resource/pjnv-eaih.json |
| State | DE |
| Categories | `medicina`, `enfermeria`, `farmacia`, `dentista`, `fisioterapia`, `veterinario`, `psicologia`, `electricidad`, `fontaneria`, `hvac`, `arquitecto` |
| Est. records | ~35,000 active DE-state records across mapped professions (349,231 total across all states/statuses) |
| robots.txt | `/resource/` path is **allowed**. data.delaware.gov only disallows browse-UI filter params and admin paths. Crawl-delay: 1s (respected). |
| Fetch method | Socrata SODA v2 JSON API — paginated GET with SoQL `$where`, `$limit`, `$offset`. No auth, no JS, no Cloudflare. |

### Pre-flight checks (2026-05-29)

- **robots.txt**: `curl https://data.delaware.gov/robots.txt` — only disallows
  `/browse?*&category=` etc. (UI filter paths) and `/api/odata/`.
  The `/resource/<id>.json` API path is NOT disallowed. ✓
- **No auth/WAF**: Plain GET returns HTTP 200 from datacenter IPs. ✓
- **Record count**: `$select=count(*)` returns 349,231 total; 61,910 active DE-state;
  ~35,358 active DE-state in mapped profession_id values. ✓
- **Professions mapped**:
  - `Electrical Examiners` (3,843 active DE) → `electricidad`
  - `Plumbing/HVACR` (1,096 active DE) → `fontaneria` / `hvac`
  - `Architecture` (166 active DE) → `arquitecto`
  - `Dentistry` (1,458 active DE) → `dentista`
  - `Medical Practice` (4,664 active DE) → `medicina`
  - `Nursing` (20,404 active DE) → `enfermeria`
  - `Pharmacy` (1,107 active DE) → `farmacia`
  - `Physical Therapy/Athletic Trg` (1,801 active DE) → `fisioterapia`
  - `Veterinary Medicine` (482 active DE) → `veterinario`
  - `Psychology` (337 active DE) → `psicologia`

## Candidates Evaluated and Rejected

| State | Agency | Reason rejected |
|-------|--------|-----------------|
| SC | LLR (Socrata data.sc.gov) | data.sc.gov ECONNREFUSED; LLR lookup portal is session-bound ASP |
| UT | DOPL | CSV download requires payment ($0.01/record); CBR is opt-in only |
| IN | PLA | CSV download requires payment ($150 + $10/1k records) |
| OK | CIB | CIB lookup is a session-bound GL.Suite portal; data.ok.gov occupational-licensing dataset is a license-types directory (not individual licensees) |
| HI | DCCA PVL | mypvl.dcca.hawaii.gov robots.txt: `Disallow: /` for all crawlers including general user-agents |
| ID | DOPL IPELS | Roster download (ipels.idaho.gov) ECONNREFUSED — domain unreachable |
| AR | ACLB | aclb2.arkansas.gov timeout; individual board roster pages are search-only with no CSV export |
| WV | Division of Labor | Individual search tools only, no bulk download |
| NM | RLD | Interactive lookup only (nmrldlpi.my.site.com) — no bulk API found |
| MT | DLI | Online search portal only, no CSV export found |
