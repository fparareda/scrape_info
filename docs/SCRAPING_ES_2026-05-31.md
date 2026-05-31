# ES Scraping Pre-flight — 2026-05-31

## Candidates Evaluated

### CGATE / VU-AT — Aparejadores / Arquitectos Técnicos (arquitecto)
- URL: http://www.vu-at.es/DirectorioProfesionales_es.asp
- Category: arquitecto
- robots.txt: HTTP 500 (server error; robots.txt unreachable)
- Endpoint type: Server-rendered ASP, no login/CAPTCHA visible on search form — but server returns 500 on most paths; individual college sites work (e.g. Valencia CAATIE at caatvalencia.es: ASP.NET pagination, ~6,937 records, public). National VU-AT portal itself is unstable.
- Record count estimate: ~37,000 nationally (per CGATE), but the central VU-AT endpoint is unreliable (500 errors on robots.txt, on BuscarProfesionales_es.asp, and on vu-at.es/vu/* paths). Directory form page at DirectorioProfesionales_es.asp does load, but results endpoint fails.
- Verdict: SKIP: national VU-AT portal has pervasive 500 errors; not reliably scrapeable at the national level. Individual college sites (Valencia, Alicante) would require per-college fan-out similar to cscae.ts, which is already the pattern for architects — too similar, and taxonomy key arquitecto is already served by cscae.ts.

### CGCAFE Ventanilla Única — Administradores de Fincas (carpinteria)
- URL: https://vu.cgcafe.org/consejo/censo.asp
- Category: carpinteria (closest taxonomy fit — property managers oversee building works)
- robots.txt: not checked (page immediately confirmed as login-protected)
- Endpoint type: BLOCKED — login-protected Classic ASP backend; redirects unauthenticated users. "Censo" page is an admin-only data entry interface for college staff, not a public directory.
- Record count estimate: unknown
- Verdict: SKIP: login required; no public search endpoint found. Not a true carpinteria source in any case — category mismatch.

### avance.digital.gob.es RegistroInstaladores — Telecomunicaciones (NOT electricidad)
- URL: https://avance.digital.gob.es/RegistroInstaladores/
- Category: N/A (telecomunicaciones only)
- robots.txt: SSL cert error (unable to verify certificate)
- Endpoint type: SSL cert failure prevents fetch; confirmed via search results to be a registry of ICT/telecom installer companies only (Types A, B, C, D, F = telecomunicaciones in buildings), NOT electricidad/REBT installers.
- Record count estimate: ~provinces×N; CSV available (1.98 MB, province-based files e.g. /Modelos/Empresas%20instaladoras/28.csv). SSL blocks direct fetch.
- Verdict: SKIP: telecomunicaciones is not in the taxonomy; also SSL cert issue prevents access.

### Comunidad de Madrid — Buscador Empresas Instaladoras (electricidad / hvac)
- URL: https://gestiona.comunidad.madrid/remp_consulta_web/run/j/ConsultaEmpresasAutorizadas.icm
- Category: electricidad or hvac
- robots.txt: gestiona.comunidad.madrid not blocked in comunidad.madrid robots.txt (only internal admin paths blocked)
- Endpoint type: JS-rendered (page shows "Buscando datos..." on load; table populated via JS; not server-rendered HTML). Specialty dropdown confirmed server-rendered via ListaValoresJSP.icm (39 specialties including Climatización, Baja Tensión, Calefacción). Results themselves require JS execution.
- Record count estimate: unknown (Madrid region only)
- Verdict: SKIP: JS-rendered results require a headless browser; regional scope (Madrid only) is a secondary concern but access pattern is the blocker.

### RII División B — Registro Integrado Industrial, Empresas Instaladoras (electricidad / hvac)
- URL: https://industria.serviciosmin.gob.es/RII/UI/Gestion/ConsultaPublicaDivisiones_B_C.aspx
- Bulk CSV: https://www6.serviciosmin.gob.es/Aplicaciones/OpenDataModule_AC202101/UbicacionRIII/Consulta%20RII%20division%20B.csv
- Category: electricidad (baja tensión) and/or hvac (instalaciones térmicas de edificios)
- robots.txt (industria.serviciosmin.gob.es): only blocks named crawlers (AhrefsBot, SemrushBot, Googlebot, Bingbot) — custom scraper bot not blocked. www6.serviciosmin.gob.es: no robots.txt (404). CSV is officially published open data on datos.gob.es (catalog entry e05024301).
- Endpoint type: Bulk CSV open data download. The CSV exceeds 10 MB (WebFetch hit max content limit), confirming very large record count. The CSV is published by Spain's Ministry of Industry as open data with daily refresh. Interactive query at industria.serviciosmin.gob.es shows "No hay registros disponibles" without POST parameters — but the bulk CSV approach is independent of the interactive UI. The CSV contains all Division B companies (electricidad, climatización, gas, refrigeración, ascensores, etc.) filterable by activity column post-download.
- Record count estimate: >50,000 combined (>10 MB CSV); electricidad (baja tensión) subset alone is likely >10,000 nationally given Spain has >100,000 registered low-voltage installer companies per REBT statistics.
- Why not already covered: existing open PRs cover RII Division A talleres (rii-div-a-talleres-es, mecanica) and RII gas companies (rii-gas-es, fontaneria). Division B electricidad and HVAC/climatización companies are a distinct, uncovered subset.
- Verdict: PICK — official government open data, large national dataset, no login/CAPTCHA, no Cloudflare, robots-allowed (custom bots not named in blocklist, and CSV is published open data). CSV approach is the recommended implementation path (not the interactive UI which appears broken without correct POST parameters).

### AEFYT — Asociación Empresas de Frío y sus Tecnologías (hvac)
- URL: https://www.aefyt.es/index.php/directorio-de-empresas
- Category: hvac
- robots.txt: not checked
- Endpoint type: Private association directory
- Record count estimate: ~210-380 member companies
- Verdict: SKIP: private association (not government/official body); far fewer than 500 records in public directory; member-only commercial association.

### Junta de Andalucía — Empresas habilitadas baja tensión (electricidad)
- URL: https://www.juntadeandalucia.es/organismos/industriaenergiayminas/areas/industria/instaladores/habilitacion-empresas/paginas/instaladores-baja-tension.html
- Category: electricidad
- robots.txt: industria and instaladores paths not blocked in juntadeandalucia.es robots.txt
- Endpoint type: NOT a direct listing — this is an informational page that redirects users to the national RII at industria.serviciosmin.gob.es. No embedded company listing.
- Record count estimate: N/A (not a listing page)
- Verdict: SKIP: not a scrapeable directory; redirects to RII which is the better source.

---

## Decision

PICK: rii-div-b-electricidad-es — RII División B Empresas Instaladoras (Baja Tensión / Electricidad) — electricidad — https://www6.serviciosmin.gob.es/Aplicaciones/OpenDataModule_AC202101/UbicacionRIII/Consulta%20RII%20division%20B.csv

**Implementation notes:**
- Download the bulk CSV from the open data URL above (also catalogued at datos.gob.es/en/catalogo/e05024301-consulta-registro-integrado-industrial-division-b).
- Filter rows by activity column for "Baja Tensión" / "Instalaciones Eléctricas" to produce the electricidad subset.
- The same CSV can yield an hvac subset ("Instalaciones Térmicas de Edificios" / "Climatización") if a second scraper is desired.
- The interactive query portal at industria.serviciosmin.gob.es/RII/UI/Gestion/ConsultaPublicaDivisiones_B_C.aspx supports filtering by División B + Sección D (Instaladora) + Habilitación but returns no results without correct ASP.NET ViewState POST; prefer the bulk CSV approach.
- robots.txt: custom bot not blocked; CSV is published open data (no restrictions).
- National scope (all 17 autonomous communities).
- Daily refresh rate per publisher metadata.
