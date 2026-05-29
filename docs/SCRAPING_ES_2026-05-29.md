# ES Scraping Research — 2026-05-29

## Selected Source

**Empresas Instaladoras y Mantenedoras de Castilla y León**
- URL: https://datosabiertos.jcyl.es/web/jcyl/risp/es/industria/instalad_mantened/1284208617621.xml
- Actual endpoint: https://servicios3.jcyl.es/reix/rxsw/siau/ServicioXMLEmpresasInstaladoras (302 redirect)
- Category: `electricidad`
- Slug: `jcyl-instaladoras-es`
- Authority: Junta de Castilla y León — Dirección General de Industria
- License: Creative Commons Attribution 4.0 (CC-BY 4.0)
- Updated: daily

### Record Count
- Total rows in XML: 40,781 (one row per company × ambitoActuacion category)
- Unique companies with BT (baja tensión / electricidad) category: **3,188**
- Unique companies across all categories: 5,905

### robots.txt
- Checked at https://datosabiertos.jcyl.es/robots.txt
- Path `/web/jcyl/risp/` is NOT in any Disallow list
- The dataset catalog path `/web/jcyl/set/` is also allowed
- Verdict: **ALLOWED**

### Data Structure
XML elements per record:
- `razonSocial` — company name
- `cif` — tax ID (unique company identifier)
- `direccion` — street address
- `codigoPostal` — postal code
- `localidad` — locality / city
- `municipio` — municipality
- `provincia` — province
- `ambitoActuacion` — installer category code + description
- `numeroAmbitoActuacion` — registration number (often empty)

### Electrical Categories (I-BT*)
- `I-BTB` — Instalador en Baja Tensión, Categoría Básica
- `I-BTE1` through `I-BTE9` — Instalador en Baja Tensión, Categoría Especialista (various specialisations)
- `M-BT*` — Mantenedor en Baja Tensión (maintainers)

### Filter Criteria Assessment
- robots.txt allows path: YES
- JS-only SPA: NO (pure XML bulk download, no JS)
- Cloudflare/captcha/login: NO
- ≥500 records: YES (3,188 electrical companies)
- Maps to existing CategoryKey: YES (`electricidad`)

## Candidates Considered and Rejected

### 1. registro.consejogestores.org (gestores administrativos — extranjeria)
- robots.txt: `Disallow: /*?*` blocks all query-parameter URLs
- Pagination requires `?page=N&...` query params
- Verdict: REJECTED (robots.txt blocks pagination)

### 2. avance.digital.gob.es (national installer registry — telecom/electricidad)
- SSL certificate error (unable to verify certificate)
- Cannot confirm robots.txt or data structure
- Verdict: REJECTED (SSL failure blocks access)

### 3. portalindustria.gva.es (Valencia installer registry)
- Consulta page returns 404
- Query interface requires JavaScript/AJAX form submission
- Verdict: REJECTED (no bulk endpoint, JS-only)

### 4. expinterweb.mites.gob.es/rea/ (REA — construcción companies)
- Request Rejected by server (WAF or auth required)
- No bulk download documented
- Verdict: REJECTED (WAF blocks access)

### 5. apiem.org (Madrid electricistas)
- Only ~1,400 records (Madrid-only), below threshold for a national source
- Verdict: REJECTED (too few records for a meaningful ES national source)
