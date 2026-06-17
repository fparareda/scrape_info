# ES Scraping Pre-flight — 2026-05-21

## Candidates evaluated

### 1. COIT — Colegio Oficial de Ingenieros de Telecomunicación
- URL: https://www.coit.es/el-colegio/directorio-de-profesionales
- robots.txt: Allows all paths except /admin/ /user/login etc. (Drupal site)
- Directory: `https://www.coit.es/print/30123` — server-rendered HTML, 9 pages
- Record count: ~450 engineers (9 pages × ~50/page) — **BELOW 500 threshold**
- Data fields: name, phone, email, address, city, specialties
- Login required: No
- Status: **REJECTED — under 500 records** (only voluntary opt-in engineers)

### 2. REBT / datos.gob.es electricidad CSV
- Searched datos.gob.es for national REBT electrical installer CSV
- Ministry catalog (sede.serviciosmin.gob.es) has NO dedicated electricidad CSV
- Only gas installers have a dedicated national CSV (covered by PR#21)
- REBT registrations are managed at CCAA level (already have aragon-instaladores,
  castilla-leon-instaladores, pais-vasco-instaladores, valencia-instaladores)
- Status: **REJECTED — no national open-data CSV for REBT electricistas**

### 3. FENIE — Federación Nacional de Empresas de Instalaciones
- URL: https://www.fenie.es/directorio-de-asociaciones/
- robots.txt: No restrictions (Disallow: empty)
- Directory: ~100+ associations (not individual companies)
- Record count: ~100 regional associations — **BELOW 500 threshold**
- Data fields: association name, phone, website
- Status: **REJECTED — directory of associations, not individual companies;
  under 500 records**

### 4. datos.gob.es search for instaladores/electricidad/HVAC/cerrajeros
- Searched datos.gob.es catalog for relevant installer datasets
- Found: RII División B (202 MB CSV, ~850k rows) — covers all installer types
- No dedicated national CSV for electricidad (REBT) or HVAC beyond RII División B
- No cerrajero or carpintería national dataset found
- Status: **RII División B selected as winner**

### 5. CGCAFE — Consejo General de Colegios de Administradores de Fincas
- URL: https://www.cgcafe.org
- robots.txt: Only /wp-admin/ disallowed
- National directory: 51 territorial college listings (no national member search)
- Individual college directories (e.g. vu.cgcafe.org/leon/prestadoresservicios.php)
  show ~22 members/page, 4 pages = ~88 per province
- Property managers ("administradores de fincas") do NOT map to any existing
  CategoryKey in the taxonomy
- Status: **REJECTED — category not in taxonomy (no "administrador-fincas" key)**

---

## Selected: rii-div-b-es — RII División B (ES electricidad + hvac)

### Source details
| Field | Value |
|---|---|
| Source slug | `rii-div-b-es` |
| Official name | Consulta RII División B — Registro Integrado Industrial |
| Publisher | Ministerio de Industria, Comercio y Turismo (Spain) |
| Dataset page | https://datos.gob.es/en/catalogo/e05024301-consulta-registro-integrado-industrial-division-b |
| Direct CSV URL | https://www6.serviciosmin.gob.es/Aplicaciones/OpenDataModule_AC202101/UbicacionRIII/Consulta%20RII%20division%20B.csv |
| File size | ~202 MB |
| Estimated rows | ~850,000 (across all División B specialties) |
| Update frequency | Daily |
| Format | UTF-8 CSV (no auth, no captcha, direct GET) |
| robots.txt | 404 on www6.serviciosmin.gob.es → permit by absence |
| Login/captcha | None |
| Cloudflare WAF | None |

### Why this is distinct from existing sources
- **rii-national.ts** uses División A (industrial establishments by CNAE).
  División B is a separate registry covering **installer/maintainer service entities**
  with explicit habilitación (licensing authorisation) by specialty.
- División A uses CNAE codes to infer categories (noisy). División B uses explicit
  `Habilitación` field → much more precise for electricidad/hvac installers.
- No existing scraper covers División B.
- No open PR covers División B.

### Category mapping
```
Habilitación = "Baja Tensión"                        → electricidad
Habilitación = "Alta Tensión"                        → electricidad
Habilitación = "Instalaciones Térmicas de Edificios" → hvac
Habilitación = "Instalaciones de Gas"                → skipped (PR#21 covers gas)
```

### Data fields available
- `Titular` → company name
- `Documento` → NIF (company tax ID)
- `Número Identificación` → RII registration number (used as sourceId)
- `Habilitación` → installer specialty (used for category mapping)
- `Categoría/Especialidad` → sub-category
- `Municipio - Localidad` → city (used for citySlug)
- `Provincia` → province (fallback for citySlug)
- `CCAA` → autonomous community (metadata)
- `Estado` → status (filter: ACTIVO only)

**Note:** No phone, email, or address in División B export. These fields exist
in the gas installer CSV (División Gas) but not in the general División B export.

### Implementation notes
- Implemented with streaming `ReadableStream` + `TextDecoder` to avoid loading
  202 MB into memory at once (OOM risk with `response.text()`).
- Batch size: 500 records per sink.upsert() call.
- Default limit: 200,000 records (configurable via PROLIO_RII_DIV_B_ES_LIMIT).
- Schedule: monthly (1st of month, 03:00 UTC) — data changes slowly.

---

## Rejected candidates summary
| Candidate | Reason |
|---|---|
| COIT ingenieros telecomunicación | <500 records (only ~450 voluntary opt-in) |
| REBT nacional CSV | No national open-data CSV exists |
| FENIE directorio asociaciones | <500 records (associations, not companies) |
| CGCAFE administradores fincas | Category not in taxonomy |
