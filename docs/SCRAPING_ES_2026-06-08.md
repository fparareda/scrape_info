# ES Scraping Research — 2026-06-08

Pre-flight research for a new ES professional/company-contact source
targeting priority categories: fontaneria, hvac, cerrajero.

---

## Candidates Researched

### 1. CONAIF (conaif.es) — fontaneria / hvac
**URL**: https://conaif.itg.es/ubicacion-unica/huelva/?directory_type=general  
**Status**: BLOCKED — timeout on fetch. The directory at `conaif.itg.es` is a
member association listing (74 associations, not individual installer companies).
No public register of individual fontaneros found.  
**Decision**: BLOCKED (not a company/professional directory, no individual records).

### 2. APECS (apecs.es) — cerrajero
**URL**: https://apecs.es/buscar-cerrajeros-en-apecs/  
**Status**: BLOCKED — only 81 members (below 500-record minimum). HTML with
server-side rendering, but too few records to be useful.  
**Decision**: BLOCKED (81 records < 500 minimum threshold).

### 3. UCES (uces.es) — cerrajero
**URL**: https://uces.es/encuentra-tu-cerrajero/  
**Status**: BLOCKED — JavaScript SPA with AJAX/dynamic loading. No static
endpoint found. Province-based search triggers JS, no raw data accessible.  
**Decision**: BLOCKED (JS SPA, no accessible API endpoint).

### 4. CONAIFSEDIGAS (conaifsedigas.es) — fontaneria / hvac
**URL**: https://www.conaifsedigas.es/listado-de-instaladores-disponibles  
**Status**: BLOCKED — only ~60 records on a single static HTML page. This is a
job board / availability list, not a national registry.  
**Decision**: BLOCKED (only ~60 records < 500 minimum threshold).

### 5. RII Gas CSV (serviciosmin.gob.es) — fontaneria
**URL**: https://www6.serviciosmin.gob.es/Aplicaciones/OpenDataModule_AC202101/UbicacionRIII/Consulta%20RII%20Instaladores%20Gas.csv  
**Status**: VALID but ALREADY IN OPEN PR — This source (26,465 rows, national gas
installer registry) is already being implemented in open PR #102 (rii-gas-es) and
PR #130 (rasic-instaladores-cat). Not implementing here to avoid duplication.  
**Decision**: SKIP (already in open PRs for fontaneria).

### 6. RASIC Cataluña qcrr-stew (analisi.transparenciacatalunya.cat) — fontaneria/hvac/cerrajero
**URL**: https://analisi.transparenciacatalunya.cat/resource/qcrr-stew.json  
**Status**: VALID but ALREADY IN OPEN PR — This Socrata dataset covers multiple
categories (gas/fontaneria ~8,157 records, thermal/hvac ~9,898 records,
pci/cerrajero ~800 records, electrical ~13,144 records). Already implemented in
open PR #130 (rasic-instaladores-cat).  
**Decision**: SKIP (already in open PR).

### 7. RII División B CSV — Thermal/HVAC (PICKED)
**URL**: https://www6.serviciosmin.gob.es/Aplicaciones/OpenDataModule_AC202101/UbicacionRIII/Consulta%20RII%20division%20B.csv  
**robots.txt**: No robots.txt at www6.serviciosmin.gob.es (404 = allowed by
absence). Ministry of Industry CC-BY 4.0 open-data policy explicitly permits
reutilización.  
**Format**: Single 202 MB CSV, no login/captcha/WAF. Direct HTTP GET.  
**Record count**: 771,937 total rows; **114,626 rows** with `Habilitación` =
"Instalaciones Térmicas de Edificios". After deduplication by NIF (same company
appears as both "Instaladora" and "Reparadora/Mantenedora"), estimate
~50,000–60,000 unique HVAC companies covering all 50 Spanish provinces.  
**Last-Modified**: Thu, 31 Aug 2023 (annual export cadence).  
**Fields**: `Fecha Registro`, `Estado`, `Titular`, `Documento` (NIF), `Número
Identificación`, `CCAA`, `División`, `Sección`, `Habilitación`,
`Categoría/Especialidad`, `Identificación`, `Municipio - Localidad`, `Provincia`,
`País`.  
**Category**: `hvac` — canonical mapping for Spanish building thermal installation
companies (calefacción, climatización, agua caliente sanitaria).  
**Decision**: PICKED — new source `rii-div-b-termicas-es`. Not in any existing open
PR. Provides national HVAC coverage from an official Ministry of Industry registry.
Sister scraper `rii-div-b-electricidad-es` (open PR #120) uses the same CSV URL
but filters only for "Baja Tensión" (electrical); thermal rows are discarded there.

---

## Implementation

- **Slug**: `rii-div-b-termicas-es`
- **CategoryKey**: `hvac`
- **Source file**: `src/sources/rii-div-b-termicas-es.ts`
- **Estimated records**: ~50,000 unique HVAC companies after NIF dedup
- **Update cadence**: Monthly cron (annual data export)
