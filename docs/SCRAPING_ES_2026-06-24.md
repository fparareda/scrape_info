# ES Scraping Research — 2026-06-24

## Summary

Researched new scrapeable web sources for Spain (ES). One viable candidate found and implemented.

---

## Candidate 1 — REJECTED: Registro de Gestores Administrativos (extranjeria)

**URL:** https://registro.consejogestores.org/

**Category:** extranjeria

**Rejection reason:** `robots.txt` at `registro.consejogestores.org` contains `Disallow: /*?*`, which blocks all URL paths containing query parameters. Since pagination relies on `?pageNumber=N`, the entire paginated listing is blocked by robots.txt. Cannot implement without violating crawling rules.

**Data quality:** 500+ records, no login, no CAPTCHA, Spain-wide coverage. Would have been a strong candidate otherwise.

---

## Candidate 2 — REJECTED: COP Galicia talleres (mecanica)

**URL:** https://abertos.xunta.gal → redirects to `https://oficinavirtualindustria.xunta.gal/RUE-Portal/buscador/talleresExportAll`

**Category:** mecanica

**Rejection reason:** Already implemented as `ccaa/galicia-talleres` in `src/sources/ccaa/galicia-talleres.ts`.

---

## Candidate 3 — REJECTED: Catalonia vehicle repair workshops (mecanica)

**URL:** https://datos.gob.es/en/catalogo/a09002970-talleres-de-reparacion-de-vehiculos

**Category:** mecanica

**Rejection reason:** Already covered by `rasic-talleres-cat` (in `types.ts`).

---

## Candidate 4 — REJECTED: Galicia vehicle repair workshops (mecanica)

**URL:** https://datos.gob.es/en/catalogo/a12002994-registro-de-talleres-de-reparacion-de-vehiculos1

**Category:** mecanica

**Rejection reason:** Same as Candidate 2 — already implemented as `ccaa/galicia-talleres`.

---

## Candidate 5 — REJECTED: Junta de Andalucía talleres (mecanica)

**Search:** datos.gob.es + juntadeandalucia.es/datosabiertos

**Category:** mecanica

**Rejection reason:** No CSV/ODS dataset for vehicle repair workshops found on the Andalucía open data portal. Portal search for "talleres" returned zero results. No open dataset exists for Andalucía at this time.

---

## Candidate 6 — REJECTED: Aragon talleres (mecanica)

**Search:** opendata.aragon.es

**Category:** mecanica

**Rejection reason:** No vehicle repair workshops dataset found on the Aragón Open Data portal. Search returned no results specific to talleres de reparación de vehículos.

---

## Candidate 7 — REJECTED: Region de Murcia talleres (mecanica)

**Search:** datosabiertos.regiondemurcia.es

**Category:** mecanica

**Rejection reason:** No vehicle repair workshops dataset found. The Murcia open data catalog (356 datasets total) has no talleres-related entry.

---

## Candidate 8 — REJECTED: COPC — Col·legi Oficial de Psicologia de Catalunya (psicologia)

**URL:** https://www.copc.cat/es/directori-professional

**Category:** psicologia

**Rejection reason:** `robots.txt` at `copc.cat` contains `Disallow: /` for `ClaudeBot` user-agent. Directory pages return HTTP 403.

---

## Candidate 9 — REJECTED: COP Galicia (psicologia)

**URL:** https://copgalicia.gal/colexiados/comarca

**Category:** psicologia

**Rejection reason:** Directory pages return HTTP 500 Internal Server Error (unstable endpoint). Additionally, pagination URLs use query parameters in Drupal format — unclear if allowed under robots.txt (which blocks `/search/` and admin paths). Not reliable enough to implement.

---

## Candidate 10 — REJECTED: COPAO Andalucía Occidental search (psicologia)

**URL:** https://sede.copao.es/buscar-un-psicologo

**Category:** psicologia

**Rejection reason:** Requires at least one search parameter to show results ("Para ver resultados, por favor, inserte algún parámetro de búsqueda"). Cannot enumerate all records without using a forced enumeration technique that would be fragile.

---

## Candidate 11 — REJECTED: Censo General de Letrados — Abogacía Española (abogado)

**URL:** https://www.abogacia.es/servicios-abogacia/censo-de-letrados/

**Category:** abogado

**Rejection reason:** Requires authentication via `acceso.abogacia.es` (login). Not publicly accessible without credentials.

---

## Candidate 12 — IMPLEMENTED: COPAO — Colegio Oficial de Psicología de Andalucía Oriental (psicologia) ✓

**URL:** https://www.copao.com/index.php/ventanilla/directorio-profesional

**Category:** psicologia

**Slug:** `copao-psicologia-es`

**Record count:** ~601 practicing psychologists (as of 2026-06-24)

**Geographic coverage:** Provinces of Almería, Granada, Jaén and Málaga (Andalucía Oriental)

**robots.txt:** Only blocks Joomla system paths (`/administrator/`, `/api/`, `/bin/`, `/cache/`, `/cli/`, `/components/`, `/includes/`, `/installation/`, `/language/`, `/layouts/`, `/libraries/`, `/logs/`, `/modules/`, `/plugins/`, `/tmp/`). The public directory path `/index.php/ventanilla/directorio-profesional` is not blocked; no `Disallow: /*?*` rule.

**Pagination:** `?start=N&limit=100` (100 per page, 7 pages total: 6 full + 1 partial)

**Auth/CAPTCHA:** None. Fully public, server-rendered Joomla HTML.

**Data fields:** Member code (AO#####), full name, province, phone (optional), location (optional)

**License:** Public professional directory (Ventanilla Única de la Directiva de Servicios), no specific download license mentioned. Public disclosure required by Spanish professional college regulations.

**Files changed:**
- `src/sources/copao-psicologia-es.ts` (new)
- `src/types.ts` — added `"copao-psicologia-es"` to `ScrapeSource` union
- `src/index.ts` — import, enabled var, early-exit guard, batch dispatch
- `.github/workflows/_scrape-runner.yml` — `PROLIO_RUN_COPAO_PSICOLOGIA_ES` flag
- `.github/workflows/scrape-copao-psicologia-es.yml` (new)
