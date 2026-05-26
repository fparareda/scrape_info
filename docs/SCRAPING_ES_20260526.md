# ES Scraping Research — 2026-05-26

Candidates researched in priority order per the expansion mandate.
Decision: implement scraper for the first viable candidate found.

---

## Candidate 1 — CGCGA Gestores Administrativos (fiscal)

**Target:** Consejo General de Colegios de Gestores Administrativos de España  
**Category:** fiscal  
**Estimated records:** ~12,000 gestores across Spain  
**URLs checked:**
- `https://www.gestores.es` — landing page; search at `/buscar/` is both **disallowed in robots.txt** (`Disallow: /buscar/`) and returns 404.
- `https://registro.consejogestores.org/` — the real public registry; server-rendered HTML with advanced search by name, province, specialty. All pagination uses query strings (e.g. `index.php?apellido1=&pageNumber=2`).
- `https://registro.consejogestores.org/robots.txt` — **`Disallow: /*?*`** blocks all URLs with query strings.

**Verdict: NOT VIABLE** — robots.txt disallows all query-string URLs, which are required for any paginated or filtered search. The registry is accessible as a web form but robots.txt explicitly forbids automated traversal of any parameterised URLs.

---

## Candidate 2 — Colegios de Mediadores de Seguros (fiscal)

**Target:** Colegio de Mediadores de Seguros de Madrid  
**Category:** fiscal (insurance brokers/agents perform regulated financial intermediation)  
**Authority:** Colegio de Mediadores de Seguros de Madrid (one of 49 provincial colegios)  
**URL:** `https://mediadoresseguros.madrid/listado-de-colegiados/`

### Pre-flight checks

| Check | Result |
|---|---|
| robots.txt | `User-agent: * / Disallow:` (empty — everything allowed) |
| Page technology | Server-rendered HTML (WordPress), no JavaScript SPA, no React/Vue |
| Login / captcha | None |
| Cloudflare / WAF | None detected |
| Record count | ~1,000+ mediadores (full page, single non-paginated HTML) |
| Threshold (≥500) | PASS |
| Category mapping | `fiscal` (insurance intermediation is a fiscal/financial service) |
| Existing scraper | None — not covered |
| Open PR conflict | None — open PRs are `rii-div-a-talleres-es`, `icac-roac-es`, `cge-economistas-es`, `rii-div-b-es` |

### Data fields available

Each `<tr>` in the public table exposes:
- `NOMBRE COLEGIADO` — name in "APELLIDO APELLIDO, Nombre" format
- `EMPRESA` — company/firm name (may be empty for individual brokers)
- Address, phone, email (combined in one `<td>` with `<br>` separators; email in `<a href="mailto:...">`)
- `FORMA` — registration type code (1=Corredor PF, 2=Corredor PJ, 7=Agente exclusivo PF, 8=Agente exclusivo PJ, etc.)

### Legal note

The page explicitly states: *"El presente listado tiene el carácter de fuente accesible al público, de acuerdo con la normativa de protección de datos."* — confirming it is a legally designated public-access source under Spanish data protection law.

### National coverage note

The Consejo General (mediadores.info) lists 49 provincial colegios. Several others were checked:
- **Asturias** (mediadoresdesegurosasturias.com): public paginated directory, ~100–120 records, open robots.txt
- Most other provincial colegios either lack public member directories or their sites were unreachable at time of research

Madrid alone (1,000+) exceeds the 500-record viability threshold. Future work could extend the scraper to fan out to other provincial colegios with public lists (Asturias, potentially Barcelona, Valencia, etc.) to achieve national coverage matching the ~75,000 total figure.

**Verdict: VIABLE** — implementing scraper `mediadores-seguros-madrid`.

---

## Candidates 3 & 4 — Not reached

Per the mandate ("stop at the first viable one"), candidates 3 (BAESEG/Interior security companies) and 4 (Consejo General de Diplomados en Trabajo Social) were not researched in depth after candidate 2 was confirmed viable.

---

## Implementation

- **Scraper:** `src/sources/mediadores-seguros-madrid.ts`
- **Slug:** `mediadores-seguros-madrid`
- **Category:** `fiscal`
- **Enable env var:** `PROLIO_RUN_MEDIADORES_SEGUROS_MADRID=true`
- **Cap env var:** `PROLIO_MEDIADORES_SEGUROS_MADRID_LIMIT` (default 5,000)
- **Cron:** monthly on the 1st (data changes slowly)
