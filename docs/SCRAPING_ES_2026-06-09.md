# ES Scraping Preflight — 2026-06-09

## Objective
Find ONE new scrapeable source for Spain (ES) fitting existing taxonomy categories.

## Gap Analysis
All major official professional registries already covered:
- abogado: CGAE; arquitecto: CSCAE; fisioterapia: CGCFE/CGFE/ColfisiocV;
- psicología: COP; ingeniería: COGITI/CICCP/COIIM; veterinario: OCV (vucolvet);
- enfermería: CGE; farmacia: CGCOF; notario: CGN; itv: DGT-ITV;
- mecanica: RASIC (Cataluña); medicina: competitor-es-colegios-medicos;
- **dentista: guiadentistas.es ALREADY IMPLEMENTED** (guiadentistas-es source)

Remaining gaps: `fiscal`, `carpinteria`, `fontaneria`, `electricidad`, `cerrajero`.

## Candidates Evaluated

### ❌ ALREADY IMPLEMENTED: guiadentistas.es — dentista

The Consejo General de Dentistas (CGCD) DataTables API at
`guiadentistas.es/colegios/serverFO.php` is already fully scraped by
`src/sources/guiadentistas-es.ts` (52,426 dentists). Not a new source.

### ❌ BLOCKED: Consejo General de Economistas (economistas.es) — fiscal

HTTP 403 Forbidden to all non-browser requests. WAF/Cloudflare blocking.
No public API endpoint identified.

### ❌ BLOCKED by robots.txt: Gestores Administrativos (gestores.es) — fiscal

robots.txt explicitly `Disallow: /buscar/` — the search path.

### ❌ CONNECTION REFUSED: CGATE (consejocgate.es) — arquitecto técnico

`consejocgate.es` returned ECONNREFUSED. Site may be down or geo-blocking
datacenter IPs. ~45k aparejadores would map to `arquitecto` if accessible.
Reserved for future pre-flight.

## Verdict: SKIPPED

All viable candidates for categories in the current taxonomy are either already
implemented or blocked (403/robots). No new viable ES source found in this run.

**Action:** Extend ES coverage by:
1. Retrying CGATE from a residential IP (potential `arquitecto` win, ~45k records)
2. Adding REAF (Registro de Economistas Asesores Fiscales) once the
   economistas.es WAF situation is resolved
