# ES Scraper Research — 2026-05-22

## Summary

One viable source identified and implemented: **ICAC ROAC** (`icac-roac-es`).

---

## Candidates Evaluated

### 1. Consejo General de Dentistas — `consejodentistas.es` — REROUTED

- URL: https://www.consejodentistas.es/ciudadanos/buscador-de-dentistas/
- robots.txt: Allows all paths except `/wp-content/uploads/` and `*.pdf$`
- Outcome: **REROUTED** — The homepage confirms the national dentist finder is hosted
  at **guiadentistas.es**, which is already in the repo as `guiadentistas-es`.
  The ventanillaunicadentistas.es subdomain had an expired TLS certificate.
  No additional accessible endpoint found.

### 2. Registro de Mediadores de Seguros (DGSFP) — BLOCKED

- URL: https://registrodemediadores.dgsfp.mineco.gob.es/
- Category candidate: `fiscal`
- Outcome: **BLOCKED** — `ECONNREFUSED` from datacenter IP; the server at
  `registrodemediadores.dgsfp.mineco.gob.es` refused the TCP connection entirely.
  Not accessible from the GitHub Actions runner.

### 3. ICAC ROAC — Registro Oficial de Auditores de Cuentas — VIABLE ✓

- URL: https://www.icac.gob.es/buscador-roac
- robots.txt: Does NOT disallow `/roac/` paths. Only disallows `/admin/`,
  `/user/`, `/search/`, `/servicios-roac/sanciones`, `README.txt`, `web.config`.
  Path `/roac/consultas/roac_001.php` is allowed.
- Technology: Drupal CMS site embeds an iframe to a legacy PHP search at
  `https://www.icac.gob.es/roac/consultas/busqueda1.php`. That PHP page POSTs
  to `roac_001.php` which returns a server-rendered HTML table.
- Data available:
  - `roac_001.php`: POST with `nombre=`, `tipo=Auditor|Sociedad|Ambos`,
    `situacion=-1|1|5`, `provincia=<provincia>` → HTML table with
    ROAC number, name, province, status. No auth token required (old endpoint).
  - `roac_002.php?nroac=<id>`: Detail page with full address, postal code,
    province, website.
  - ~3,451 ejerciente (practicing) auditors, ~1,338 audit societies = **~4,789
    active entities**. Total including non-ejerciente ~9,197.
  - All under the 10,000-row server cap when fetched by type separately.
- Category: `fiscal` (auditors handle statutory financial auditing = closest
  taxonomy match; same rationale as `graduados-sociales-es`).
- Pre-flight: PASS — robots.txt allows, server-rendered HTML, ≥500 records,
  no auth/CAPTCHA/login wall, maps to `fiscal`, not already in repo or any open PR.
- **IMPLEMENTED** as `icac-roac-es`.

---

## Implementation Notes

- Source fetches ejerciente auditors (tipo=Auditor, situacion=1) and audit
  societies (tipo=Sociedad) in two POST requests to `roac_001.php`.
- Province is extracted from the list HTML; city slug derived from province
  via a static mapping table covering all 52 Spanish provinces.
- Detail page (`roac_002.php`) is NOT fetched per record (would require ~4,789
  additional HTTP requests); address/website data from the list page is used.
  Detail fetching can be added in a future enhancement.
- Polite UA first, Chrome UA fallback on 403/503.
- Cap: `PROLIO_ICAC_ROAC_ES_LIMIT` (default 5000).
- Schedule: monthly (1st of month, 03:00 UTC) — ROAC rolls update annually.
