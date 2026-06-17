# CA Scraper Research — 2026-06-14

## Primary candidate: CICC national register (extranjeria)

**URL:** https://register.college-ic.ca/Public-Register-EN/Public-Register-EN/Default.aspx
**Result:** BLOCKED — returns HTTP 403 to all crawlers (both datacenter IP and Chrome UA).
The subdomain `register.college-ic.ca` is served behind a WAF that drops all non-browser
sessions. robots.txt does not explicitly block but the site is inaccessible.

## Implemented: RQCI — Registre québécois des consultants en immigration

**Source slug:** `rqci-qc-ca`
**Category:** `extranjeria`
**Country / Province:** CA / QC

### Data origin

Published by the Ministère de l'Immigration, de la Francisation et de l'Intégration (MIFI)
under Creative Commons Attribution 4.0.

- Open Canada catalog: https://open.canada.ca/data/en/dataset/23f8d075-4574-4238-a3d1-f3ba5674fce0
- Données Québec portal: https://www.donneesquebec.ca/recherche/dataset/registre-quebecois-des-consultants-en-immigration
- CSV download (2026-06-14 snapshot): `consultants20260527.csv` (~726 rows)

### robots.txt audit

**donneesquebec.ca** robots.txt:
```
User-agent: *
Disallow: /wp-admin/
Allow: /wp-admin/admin-ajax.php
Disallow: /recherche/dataset/*?
Disallow: /recherche/organization/*?
Disallow: /recherche/group/*?
Disallow: /recherche/dataset/rate/
Disallow: /recherche/revision/
Disallow: /recherche/dataset/*/history
Disallow: /recherche/api/
Disallow: /api/
Crawl-Delay: 10
```

The direct CSV download path (`/recherche/dataset/<uuid>/resource/<uuid>/download/<file>.csv`)
is NOT disallowed. The scraper uses the open.canada.ca CKAN API (robots.txt: only `/core/`
and `/libraries/` disallowed) to discover the current filename, then fetches the CSV directly
from donneesquebec.ca.

### Data format

UTF-8 BOM CSV, comma-delimited, ~726 rows. Columns:
- STATUT: `REC` (Reconnu = active) or `REV` (Révoqué = revoked)
- NOINSCRIPTION: registration number (used as sourceId)
- NOM / PRENOM: surname / given name
- DATERECONNAISSANCE: date of recognition (YYYY-MM-DD)
- ENTREPRISEADRESSE1-3: business address lines
- ENTREPRISEVILLE / ENTREPRISEPROVINCE / ENTREPRISECODEPOSTAL: city/province/postal
- COURRIEL: email address

### Record count estimate

- Total rows: 726
- Active (REC): 682
- Revoked (REV): 44
- After scraper filters: ~682 records

### Top cities (active records)

Montréal: 322, Laval: 62, Québec: 31, Brossard: 26, Saint-Laurent: 25, Gatineau: 20,
Longueuil: 19, Terrebonne: 13, Sherbrooke: 11, Verdun: 10.

All records map to Quebec (province QC). Montreal boroughs (Saint-Laurent, Verdun, etc.)
and Brossard are mapped to nearby city slugs in the CA DB.

### Viability checklist

- [x] robots.txt allows the download path
- [x] Server-rendered CSV (no JS/SPA needed)
- [x] >= 500 records (682 active)
- [x] No login / no CAPTCHA / no Cloudflare
- [x] Maps to existing CategoryKey (`extranjeria`)
- [x] Open licence (CC-BY 4.0)

### Pre-flight notes

- The CSV filename includes a date (e.g. `consultants20260527.csv`). The scraper discovers
  the current URL at runtime via the open.canada.ca CKAN API to stay robust across MIFI
  monthly updates.
- Schedule: monthly (1st of each month at 04:00 UTC) — aligned with MIFI update cadence.
- Crawl-Delay: 10 respected; the scraper makes exactly 2 HTTP requests per run
  (1 CKAN API call + 1 CSV download).
