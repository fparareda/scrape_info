# ES Scraper Research — 2026-05-15

## Candidates evaluated

### Candidate A — CGCV / Veterinarios.com (veterinario)
- **URL**: https://www.veterinarios.com
- **Verdict**: TIMEOUT / not reachable
- Notes: Main domain timed out. Regional colegios checked (COLVEMA Madrid,
  COVB Barcelona, ICOVV Valencia, Zaragoza, Almería) — all are either
  JS-only SPAs (COVB, ICOVV, Almería), server-side form-required (COLVEMA
  redirects to a POST-only form), or only ~150 records with no address data
  (Zaragoza). The national ventanilla única at vucolvet.org has a 3-character
  minimum search field that prevents enumeration. COLVET.es national body has
  no public member API. No viable national veterinario source found.

### Candidate B — COP España / Psicólogos (psicologia)
- **URL**: https://cop.es/
- **Verdict**: REDIRECTS to homepage — no public colegiados directory
- Notes: cop.es redirects all /colegiados/ and /buscador-colegiados/ paths
  to the homepage. Regional colleges investigated.
  - **COPC Catalonia** (copc.cat) — 403 Forbidden
  - **COPCV Valencia** — connection refused
  - **COPM Madrid** (web.copmadrid.org) — **VIABLE** ✓

### Candidate C — COIIQ / Ingenieros (ingenieria)
- **URL**: https://www.coiiq.org / https://www.cogiti.es
- **Verdict**: BLOCKED — no public member directory
- Notes: COGITI buscador-de-ingenieros returned 404. No accessible public
  directory found for ingenieros at national level.

---

## Selected source: COPM Madrid — Colegio Oficial de Psicólogos de Madrid

- **URL**: https://web.copmadrid.org/ciudadania/servicios-al-ciudadano/listado-colegiados
- **Category**: `psicologia`
- **robots.txt**: web.copmadrid.org returns 404 (no robots.txt = allow all).
  www.copmadrid.org robots.txt blocks /web/img_db/, /web/files/, /img_db/,
  /files/ — none of these match the listado-colegiados path.
- **Auth / WAF**: None observed. No captcha, no login, no Cloudflare.
- **Format**: Server-rendered paginated HTML, 10 records per page, `?page=N`
- **Record count**: 22,687 psychologists (page 1 confirms: "22687 resultados")
- **Pagination**: 2,269 pages total
- **Data per record**: name, registration number (M-#####), academic
  qualification, professional status (Ejerciente/No ejerciente)
- **City mapping**: All records map to `madrid` (single-college, Madrid province)
- **Slug**: `copm-psicologos`

### Pre-flight checklist
- [x] robots.txt: allowed (no restrictions on listado path)
- [x] Auth/WAF: none
- [x] Format: server-rendered HTML, standard pagination
- [x] Record count: 22,687 ≥ 500 ✓
- [x] Name + city: name per record, all Madrid
