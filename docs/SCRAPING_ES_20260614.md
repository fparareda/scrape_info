# ES Scraping Research — 2026-06-14

## Selected Source: Junta de Castilla y León — Talleres de Reparación de Vehículos

### Summary
Open-data CSV listing all registered motor-vehicle repair and maintenance workshops
(CNAE 4520) in the autonomous community of Castilla y León. Published by the
Dirección General de Industria under Creative Commons Attribution 4.0. Distinct
from the already-covered Catalonia source (rasic-talleres-cat).

### Dataset page
https://datosabiertos.jcyl.es/web/jcyl/set/es/industria/talleres-reparacion-vehiculos/1284993284985

### Direct CSV download
https://transparencia.jcyl.es/economia/industria/talleres-reparacion-vehiculos.csv
(302-redirect from the datos-abiertos page)

### robots.txt
`https://transparencia.jcyl.es/robots.txt` — only disallows `/Presidencia/IPUB/`
and `/sioc/`. The CSV endpoint `/economia/industria/...` is fully open.

### Data format
Plain CSV, ~937 KB, UTF-8 (or latin-1 with BOM). Columns:
- `PROVINCIA` — Castilla y León province (e.g. ÁVILA, BURGOS, SALAMANCA…)
- `MUNICIPIO` — municipality name
- `LOCALIDAD` — locality (may differ from municipality)
- `TIPO` — street type (CALLE, AVENIDA, etc.)
- `CALLE` — street name
- `Nº` — street number
- `C. POSTAL` — postal code
- `TITULAR` — company/owner name
- `CNAE PRINCIPAL` — CNAE code (4520 = vehicle maintenance & repair)
- `DESCRIPCIÓN CNAE` — CNAE description

### Record count estimate
~1,000+ rows (exact count varies; the CSV is 937 KB covering all nine provinces
in Castilla y León).

### Category mapping
`mecanica` — CNAE 4520 maps directly to auto repair/maintenance.

### Pre-flight notes
- No login, no CAPTCHA, no Cloudflare, no JavaScript SPA
- Direct CSV download, server-rendered
- Updated annually; monthly scrape cadence is appropriate
- Licensed CC BY 4.0 — attribution to Junta de Castilla y León required
- Different CCAA from rasic-talleres-cat (Catalonia) — no duplication

---

## Other candidates researched (rejected)

### Galicia — Rexistro de Talleres de Reparación de Vehículos
- URL: https://abertos.xunta.gal (redirect to oficinavirtualindustria.xunta.gal)
- Data: ODS (OpenDocument Spreadsheet) from live endpoint; 401 KB
- Issue: ODS format requires a full ODS parser not currently in the codebase;
  no plain CSV or JSON endpoint available. Deferred for future work.

### Andalucía — Empresa instaladora fontanería
- Searched for open-data fontaneria registries in Andalucía
- No downloadable registry found; the regulation deregistered mandatory
  fontanería inscription in Madrid (Decreto 57/2013), and Andalucía has no
  publicly accessible CSV/JSON registry.

### Comunidad de Madrid — Buscador de empresas instaladoras y mantenedoras
- URL: https://www.comunidad.madrid/inversion/industria/buscador-empresas-instaladoras-mantenedoras
- Issue: Interactive web form only; no API or downloadable data; does not cover
  fontanería (plumbing deregulated in Madrid since 2013).

### REITE / RITE — Registro de instaladores térmicos
- Searched for national REITE/RITE installer registry
- No accessible national CSV/JSON download found; registration is managed
  per-Comunidad Autónoma with no consolidated open-data export.
