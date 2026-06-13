# ES Source Expansion — Pre-flight Research Log (2026-06-13)

## Mission

Find ONE new scrapeable web source for Spain (country code ES) that fits the existing taxonomy, implement it, and open a PR.

Focus categories: `fontaneria`, `cerrajero`, `abogado`, `extranjeria`.

---

## Candidate Evaluation

### SKIP: abogacia.es / Censo General de Letrados (abogado)

- URL: `https://www.abogacia.es/servicios-abogacia/censo-de-letrados/`
- Status: Page redirects to mobile app download only. No web search UI.
- Result: **SKIP — app-only, no web API.**

### SKIP: ventanillaunicaabogados.org (abogado)

- URL: `https://ventanillaunicaabogados.org/`
- Status: JSF (JavaServer Faces) stateful session. Requires `javax.faces.ViewState` token per request; cannot be scraped without full browser session state.
- Result: **SKIP — JSF session state, no stateless pagination.**

Note: `cgae.ts` already exists in the codebase covering the abogado category via individual colegios.

### SKIP: ICAM Madrid (abogado)

- URL: `https://web.icam.es/censo-letrados/`
- Status: reCAPTCHA v3 present on the Censo page.
- Result: **SKIP — reCAPTCHA.**

### SKIP: ICAV Valencia / ICAV Valladolid (abogado)

- URL: `https://www.icav.es/ver/69/busca-un-colegiado.html`
- Status: Form requires at least one search criterion (Nº Colegiado, Nombre, Apellidos, or Postal Code). No bulk listing available.
- Result: **SKIP — mandatory search criteria, no bulk listing.**

### SKIP: Consejo General de Gestores Administrativos (extranjeria/fiscal)

- URL: `https://registro.consejogestores.org/`
- robots.txt: `Disallow: /*?*` — blocks ALL query-string URLs including `?pageNumber=N` pagination.
- Path-based pagination tested (`/page/2/`) → HTTP 404.
- Result: **SKIP — robots.txt disallows query strings.**

### SKIP: datos.gob.es generic queries (fontaneria, cerrajero)

- Existing source `datos-gob-es.ts` already covers these via QUERY_MAP entries:
  - "instaladores-gas" → fontaneria
  - "instaladores-fontaneria" → fontaneria
  - "cerrajeria" → cerrajero
- API verification: `datos.gob.es/apidata/catalog/dataset/title/instaladores%20fontaneria` → returns 0 items (empty corpus for this specific query).
- Result: **Already covered by existing source (even if sparse).**

### SKIP: RII División A / ccaa/rii-national.ts (fontaneria, electricidad)

- Already in codebase: `src/sources/ccaa/rii-national.ts`
- Covers CNAE 432 (electricidad + fontaneria), 433 (carpinteria), 452 (mecanica), 712 (itv).
- Result: **Already covered.**

### SKIP: CGCAFE / Ventanilla Única Administradores de Fincas (fiscal)

- URL: `https://vu.cgcafe.org/consejo/censo.asp`
- Status: Login form (Usuario + Clave). National VU is login-gated.
- Individual colegios (Cádiz, Extremadura, Baleares) have public listings but are too small (<500 entries nationally meaningful).
- Result: **SKIP — national VU login-gated; regional colegios too small.**

### SKIP: RECEX / Registro de Colaboradores de Extranjería (extranjeria)

- URL: `https://www.inclusion.gob.es/en/regularizacion/colaboradores`
- Status: 492 entities (NGOs and trade unions), created March 2026.
- This registry covers organizations helping migrants, NOT individual immigration lawyers/gestores.
- Result: **SKIP — wrong entity type (NGOs, not professionals).**

### SKIP: Consejo General de Economistas – national search (fiscal)

- URL: `https://economistas.es/buscar-colegiados/`
- Status: HTTP 403 Forbidden (Cloudflare WAF blocks datacenter IPs).
- Result: **SKIP — Cloudflare 403.**

### SKIP: REAF directorio de miembros (fiscal)

- URL: `https://reaf.economistas.es/directorio-de-miembros/`
- Status: HTTP 403 Forbidden.
- Result: **SKIP — 403.**

### SKIP: vu-at.es / Ventanilla Única Arquitectura Técnica (arquitecto)

- URL: `http://www.vu-at.es/DirectorioProfesionales_es.asp`
- Status: HTTP 500 Internal Server Error.
- Result: **SKIP — server error.**

### SKIP: caatvalencia.es / CAAT Valencia aparejadores (arquitecto)

- URL: `https://www.caatvalencia.es/pub/directorio_colegiados.aspx`
- Status: Shows ~10 entries per page, pagination via ASP.NET `__doPostBack` ViewState (stateful).
- Cannot be scraped with simple GET requests; requires full ASP.NET session.
- Result: **SKIP — ASP.NET postback pagination, stateful session required.**

---

## IMPLEMENTED: COEV — Colegio Oficial de Economistas de Valencia

### Pre-flight Verification

| Check | Result |
|---|---|
| URL | `https://www.coev.com/colegiados` |
| robots.txt | `Disallow:` (empty) — all paths allowed |
| HTTP status | 200 OK |
| Auth required | No |
| CAPTCHA | No |
| JS-only SPA | No (server-rendered HTML) |
| Total records | 4,120 colegiados |
| Pagination | `?page=N` zero-indexed GET param, 25 entries/page |
| Cloudflare | No |

### Why COEV

- Colegio Oficial de Economistas de Valencia is one of Spain's largest economics colleges.
- 4,120 licensed economists — well above the 500-record threshold.
- robots.txt: fully open (Disallow: with no path — all bots allowed).
- Simple paginated GET requests with no session state required.
- Maps to `fiscal` category: Spanish economists (Economistas Colegiados) provide tax advice, financial consulting, and fiscal representation — the closest fit to Prolio's `fiscal` category.
- No competing source in the codebase covers this professional body.

### Source Details

- **Slug**: `coev-economistas`
- **Category**: `fiscal`
- **Country**: ES
- **City**: `valencia`
- **Pagination**: `?page=0`, `?page=1`, ... (25 entries/page, ~165 pages)
- **Record format**: Colegiado number + full name (apellidos, nombre)
- **Env flag**: `PROLIO_RUN_COEV_ECONOMISTAS=true`
- **Cap env**: `PROLIO_COEV_ECONOMISTAS_LIMIT` (default 5000)

### Files Changed

- `src/sources/coev-economistas.ts` (new)
- `src/types.ts` — added `"coev-economistas"` to ScrapeSource union
- `src/index.ts` — import + flag + early-exit + exec block
- `.github/workflows/_scrape-runner.yml` — SOURCE FLAG MATRIX entry
- `.github/workflows/scrape-coev-economistas.yml` (new) — weekly Sunday cron
