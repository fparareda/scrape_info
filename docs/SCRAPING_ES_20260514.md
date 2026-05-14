# ES Scraper Research — 2026-05-14

Investigates public registries in Spain to fill category gaps:
`fisioterapia`, `veterinario`, and `fiscal` (zero or minimal national ES sources).

---

## Candidates Investigated

### 1. CGCFE — Consejo General de Colegios de Fisioterapeutas de España

- **URL:** https://www.consejo-fisioterapia.org/vu_colegiados.html
- **robots.txt:** https://www.consejo-fisioterapia.org/robots.txt
  - Disallows only `/adjuntos/memoria_anual/`, `/adjuntos/cuentas_auditadas/`,
    `/adjuntos/presupuesto_contrato/`; `Allow: /` — the registry path is
    explicitly permitted.
- **Architecture:** Server-rendered HTML (traditional multi-page, Joomla-era
  stack). No React/Vue SPA. No CAPTCHA. No login required for public
  directory.
- **Directory URL pattern:**
  - Page view: `https://www.consejo-fisioterapia.org/vu_colegiados/pag_N.html`
  - CSV download (per page): `https://www.consejo-fisioterapia.org/vu_colegiados/pag_N/descargar.html`
  - Pagination: 2306 pages total (pag_1 … pag_2306)
- **Record count:** Last page (2306) ends at NUMERO 19861 → **~19,861 records**.
  Last updated 2026-05-14.
- **Bulk download endpoint:** No single-shot bulk URL found (`/vu_colegiados/descargar.html`
  returns 404). Must paginate over all 2306 pages fetching CSV per page.
- **CSV format (semicolon-delimited):**
  ```
  COLEGIO;NUMERO;NOMBRE
  Colegio Profesional de Fisioterapeutas Comunidad de Madrid;19858;Mónica Gómez Delgado
  Colegio Oficial de Fisioterapeutas del País Vasco;1;Jon Herrero Erquiñigo
  ```
- **Fields:** COLEGIO (regional college name), NUMERO (licence number, some
  formatted as `39/NNN` for Cantabria), NOMBRE (full name).
- **Verdict: VIABLE.** Robots.txt allows, no WAF/CAPTCHA, server-rendered
  HTML with stable paginated CSV download, ≥19k records, clean semicolon CSV.

### 2. CGCV / colvet.es — Consejo General de Colegios Veterinarios de España

- **URL:** https://www.colvet.es/
- **robots.txt:** Fetch timed out / redirect to sitemap only — content not
  retrieved. The robots.txt at the canonical URL could not be confirmed.
- **Directory:** No public member search found on the main colvet.es domain.
  Separate `vucolvet.org` (Ventanilla Única) has a search form requiring
  province selection + minimum-3-char text input — no bulk/paginated
  endpoint discovered. No API or download link found.
- **Verdict: NOT VIABLE (current).** No accessible paginated or bulk
  directory; form requires interactive input with no evident machine-readable
  endpoint. May be revisited if an API endpoint is discovered.

### 3. REAF — Registro de Economistas Asesores Fiscales

- **URL:** https://reaf.economistas.es/
- **robots.txt:** Server returned 403 Forbidden on direct fetch attempt.
- **Directory:** No public member directory or search tool found on the site.
  REAF is a voluntary accreditation body within the Consejo General de
  Economistas (CGE). Members are scattered across 60+ provincial colleges;
  there is no central machine-readable member list.
- **Verdict: NOT VIABLE.** No accessible directory endpoint; 403 on
  robots.txt; no public bulk data source.

---

## Selected Source

**CGCFE — cgcfe-fisioterapeutas** (fisioterapia category)

| Property | Value |
|---|---|
| Slug | `cgcfe-fisioterapeutas` |
| Category | `fisioterapia` |
| Country | ES |
| Endpoint base | `https://www.consejo-fisioterapia.org/vu_colegiados/pag_N/descargar.html` |
| robots.txt status | Allowed (`Allow: /`) |
| Record count estimate | ~19,861 |
| Format | Semicolon-delimited CSV (3 columns) |
| Pagination | 2306 pages, ~9 rows/page |
| Auth required | None |
| CAPTCHA | None |
| WAF | None observed |

### Sample record

```csv
COLEGIO;NUMERO;NOMBRE
Colegio Profesional de Fisioterapeutas Comunidad de Madrid;1;Cecilia Conde Ederra
Colegio Oficial de Fisioterapeutas del País Vasco;1;Jon Herrero Erquiñigo
Colegio Oficial de Fisioterapeutas de Canarias;1;JULIO RAMÓN FERNÁNDEZ DE ALDECOA
```

### City-slug mapping strategy

The CSV has no address/city field — only a regional college name. City slugs
are derived from a static `COLLEGE_TO_CITY` map (college name → best ES city
slug). College names correspond to the 17 autonomous communities; the largest
city in each community is used as the representative slug. Records from
colleges not in the map fall back to `madrid`.
