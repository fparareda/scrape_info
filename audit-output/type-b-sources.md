# TYPE_B — Free official sources for empty categories

> Compilación de conocimiento de dominio. Los sub-agentes hit rate-limit antes de validar URLs; cada URL aquí debe confirmarse en una preflight check antes de implementar (probe estilo `scripts/probe-colegios-medicos.mjs`).

Cada fila: dónde sacar los datos, gratis, oficial.

## 🇪🇸 España

| Categoría | Source | URL | Acceso | ~rows | Template | Difficulty |
|---|---|---|---|---|---|---|
| abogado | CGAE Censo de Letrados (federación + 83 ICA) | abogacia.es/censo | HTML búsqueda + paginación | 250k | `colegios/` pattern (clonar `cmq.ts` o `comb-barcelona.ts`) | medium — auth por colegio en algunos |
| abogado *(alt)* | RGEAJ — Registro de Letrados | mjusticia.gob.es | PDF anual | ~250k | descarga directa | easy |
| cerrajero | DENUE-ES no existe; usar **PRTR / SIEM** análogo + Páginas Amarillas | paginasamarillas.es | scraping HTML por ciudad | ~3k | `paginas-amarillas.ts` ya existe | easy |
| cerrajero *(alt)* | OSM Overpass `craft=locksmith` | overpass-api.de | OQL gratis | ~1k | `osm.ts` | easy |
| enfermeria | CGE — Consejo General de Enfermería | consejogeneralenfermeria.org | sólo búsqueda por colegio (52 provinciales) | 320k | `colegios/` pattern | hard — un scraper por provincial |
| enfermeria *(alt)* | datos.gob.es dataset RPSE | datos.gob.es/catalogo | CSV nacional si publicado | ~320k | `datos-gob-es.ts` extendido | easy if exists |
| farmacia | CGCOF + Consejos autonómicos (CACOF) | portalfarma.com | sólo búsqueda farmacéuticos por provincia | 75k | `colegios/` | hard |
| farmacia *(alt)* | **`farmaceuticos-es-guardia.ts` YA EXISTE** — sólo guardias. Extender a censo completo. | mismo dominio | misma estructura | 75k | extender existente | medium |

## 🇲🇽 México

| Categoría | Source | URL | Acceso | ~rows | Template | Difficulty |
|---|---|---|---|---|---|---|
| abogado | DENUE clase 5411 (servicios legales) | denue.inegi.org.mx | API JSON | ~120k | `denue-mx.ts` ya existe — añadir scae 5411 | easy |
| abogado *(alt)* | Barra Mexicana | bma.org.mx | scraping HTML | 12k | nuevo | medium |
| abogado *(alt2)* | SAT Padrón de Personas Físicas con actividad jurídica (cédula SEP) | sep.gob.mx/cedula | scraping JSP | ~150k | nuevo (alto valor: cubre TODOS los oficios con cédula) | medium-hard |
| enfermeria | SEP RNP (Registro Nacional de Profesionistas) cédulas de Enfermería | sep.gob.mx/cedula | scraping JSP por cédula | ~400k | mismo nuevo SEP-RNP | medium |
| farmacia | COFEPRIS — ya tenemos `cofepris-farmacias.ts` pero sólo permisos farmacéuticos comerciales. Faltan farmacéuticos como personas físicas. | cofepris.gob.mx | extender scraper actual | 30k pros | extender existente | medium |
| farmacia *(alt)* | SEP RNP cédula Química Farmacéutica | sep.gob.mx/cedula | igual SEP-RNP | 50k | igual | medium |
| cerrajero | DENUE clase 8129 (otros servicios personales) | denue.inegi.org.mx | API JSON | ~2k | `denue-mx.ts` extender | easy |
| itv | CRE/SCT permisionarios — pocos pros (programa estatal limitado) | gob.mx/cre | scraping CSV | 100 | `cre-permisionarios.ts` extender | easy |

## 🇺🇸 Estados Unidos

Prioridad: **federales/multi-estado > 50 state boards**.

| Categoría | Source | URL | Acceso | ~rows | Template | Difficulty |
|---|---|---|---|---|---|---|
| abogado | ABA Lawyer Search (federación) | americanbar.org/dir | búsqueda HTML limited results | ~50k | clonar `competitor-us-bar-associations.ts` | medium |
| abogado *(must-have)* | 50 State Bar Associations | varies | 50 scrapers, varios en `competitor-us-bar-associations.ts` ya | 1.3M total | extender existente | hard — 50 endpoints |
| arquitecto | **NCARB Directory of Architects** (federal) | ncarb.org/get-licensed/registered-architects | búsqueda por estado | 120k | nuevo | medium |
| arquitecto *(supl)* | AIA Find an Architect | aia.org/find-an-architect | búsqueda HTML | 90k | nuevo | medium |
| ingenieria | **NCEES Records / NCEES License Search** | ncees.org/records | API/scraping | 800k | nuevo (alto ROI — federal único) | medium-hard |
| ingenieria *(supl)* | State PE Boards (50) | varies | 50 sites | overlap | bajo ROI vs NCEES | hard |
| cerrajero | Yelp + OSM (no hay registro federal); algunos estados (CA, NJ, NC, TX) licencian | varies | mixed | ~5k | `osm.ts` + state board scrapers | easy |
| fisioterapia | **FSBPT — Federation of State Boards of Physical Therapy** | fsbpt.org/free-resources/license-verification | unified search engine | 400k | nuevo | medium |
| fisioterapia *(alt)* | APTA Find a PT | apta.org/apta-and-you/leadership-and-governance/sections/find-a-pt | HTML | 100k | nuevo | medium |

## 🇨🇦 Canadá

| Categoría | Source | URL | Acceso | ~rows | Template | Difficulty |
|---|---|---|---|---|---|---|
| enfermeria | CNA + provincial colleges (10) | cna-aiic.ca / cno.org / carna.ca / etc | HTML/JSON búsqueda | 450k | clonar `cpsns-ns-physicians.ts` patrón | hard — 10 provinciales |
| enfermeria *(alt easy)* | **CNO Ontario sólo** (provincia más grande) | cno.org/en/learn-about-standards-guidelines/registration | búsqueda HTML | 170k | nuevo, easy | easy |
| notario | Federación de Notarios — no existe federal; QC y BC notarios son distintos profesionalmente. CN Québec: cnq.org | cnq.org | HTML | 4k | clonar `oaq.ts` patrón | easy |
| notario *(BC)* | Society of Notaries Public of BC | notaries.bc.ca | HTML | 400 | nuevo | easy |

## 🇫🇷 Francia

| Categoría | Source | URL | Acceso | ~rows | Template | Difficulty |
|---|---|---|---|---|---|---|
| notario | **Conseil Supérieur du Notariat** | annuaire.notaires.fr | búsqueda HTML pública | 16k | nuevo `csn-notaires-fr.ts` | easy |

---

## Riesgos principales

1. **SEP RNP (MX)** — alto valor (cubre múltiples categorías de una sola fuente) pero scraping JSP histórico es frágil. Validar URL y formato actual antes de invertir.
2. **NCEES (US ingeniería)** — bloquea por scraping habitualmente. Plan B: 50 state PE boards (hard).
3. **CNO Ontario (CA enfermería)** — el "find a nurse" es público pero el rate-limit ronda 5 req/s. Plan: serial con sleep.
4. **CGCOF España (farmacia)** — los 52 colegios provinciales tienen sites heterogéneos. Reusar el patrón del `probe-colegios-medicos.mjs` para clasificar y atacar primero los easy.
5. **State bars US (50)** — clonar el patrón de `competitor-us-bar-associations.ts`. ~1/3 tendrán captcha (Cloudflare); aceptarlo y dejarlos para Fase 3 (Overture/OSM backfill).

## Recomendación de orden (alto ROI primero)

1. **CSN notaires FR** — 1 día, cierra el último hueco FR.
2. **SEP RNP MX** — 3-5 días, cubre MX abogado + enfermeria + farmacia + dentista + más en una sola fuente.
3. **NCARB + NCEES US** — 2-3 días, cubre arquitecto + ingeniería de un golpe.
4. **CGE/CGCOF/CGAE ES** — 1-2 semanas (52 provinciales pero pattern repetido).
5. **CNA + CNO CA** — 1 semana, cubre enfermería.
6. **FSBPT US** — 2 días.
7. Backfill cerrajero vía Overture/OSM en Fase 8 (todos los países).

Total estimado para cerrar TYPE_B: **3-4 semanas de trabajo continuo**.
