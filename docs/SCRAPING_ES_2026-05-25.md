# ES Scraping Pre-flight — 2026-05-25

## Goal
Find one new scrapeable source for Spain within the existing CategoryKey taxonomy.

## Taxonomy gap targeted
`mecanica` — auto repair workshops. No national ES source existed (rasic-talleres-cat.ts
covers only Catalonia; the DGT taller map is a JS-only SPA with no API).

## Candidates evaluated

### ✅ WINNER — RII División A (Ministry of Industry)

| Field | Value |
|---|---|
| **Source** | Ministerio de Industria (MINECO / MITECO) |
| **Dataset** | Registro Integrado Industrial División A |
| **Catalogue** | https://datos.gob.es/en/catalogo/e05024301-consulta-registro-integrado-industrial-division-a |
| **CSV endpoint** | `https://www6.serviciosmin.gob.es/Aplicaciones/OpenDataModule_AC202101/UbicacionRIII/Consulta%20RII%20division%20A.csv` |
| **Category** | `mecanica` |
| **Estimated records** | 19,304 (talleres filtered from 212k-row full División A CSV) |
| **Data format** | Single bulk CSV download |
| **Refresh** | Daily (government open-data portal) |
| **robots.txt** | 404 on serviciosmin.gob.es → no restrictions |
| **Auth/captcha** | None |
| **License** | Spanish open-data reuse (Real Decreto 1495/2011) |

**Fields available:** `Denominación` (trade name), `Empresa` (company), `Número Identificación`
(RII reg number, e.g. `28-A-452-03027470`), `Comunidad Autónoma`, `CNAE`, `Info. Actividad`,
`Identificación` (municipality code), `Municipio - Localidad`, `Provincia`.

**Filter:** `Info. Actividad` contains "taller" + "reparaci" → ~19,304 rows.

**Note:** PR #76 covers RII División B (electricidad + HVAC installers). División A is a
separate register (different CNAE codes, different registration number series, non-overlapping
categories).

### ❌ DGT taller map
- **URL:** https://www.dgt.es/conoce-la-dgt/con-quien-trabajamos/talleres/
- **Reason:** JS-only SPA (ArcGIS map), no static JSON endpoint discoverable; only ~1,100
  voluntarily registered workshops vs. 19k in RII.

### ❌ REA — Registro de Empresas Acreditadas en construcción (MITES)
- **URL:** https://expinterweb.mites.gob.es/rea/pub/consulta.htm
- **Reason:** Requires specific CIF/NIF to look up individual companies; no bulk export.
  Also: `carpinteria` category, not `mecanica`.

### ❌ CGCOM consulta pública de colegiados médicos
- **URL:** https://consultapublica.cgcom.es/
- **Reason:** HTTP 403 on directory paths; CAPTCHA on search form.
  Also: `medicina` category already well-covered.

### ❌ Galicia RUE-Portal talleres
- **URL:** https://oficinavirtualindustria.xunta.gal/RUE-Portal/buscador/talleres
- **Reason:** Regional only (Galicia, ~6k records); superseded by the national RII CSV.

## Implementation

**Slug:** `rii-div-a-talleres-es`  
**Source file:** `src/sources/rii-div-a-talleres-es.ts`  
**Enable flag:** `PROLIO_RUN_RII_DIV_A_TALLERES_ES=true`  
**Cap:** `PROLIO_RII_DIV_A_TALLERES_ES_LIMIT=25000`  
**Cron:** Monthly (7th of each month, 05:00 UTC) via `scrape-rii-div-a-talleres-es.yml`
