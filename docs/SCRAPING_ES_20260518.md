# ES Scraping Pre-flight — 2026-05-18

## Taxonomy gap targeted
`fiscal` — no dedicated ES source existed; all tax-advisor data was coming from
general directories or indirect sources (graduados sociales, procuradores).

## Candidates researched

### REAF-CGE (Registro de Economistas Asesores Fiscales)
- URL: https://reaf.economistas.es/directorio-de-miembros/
- **STATUS: BLOCKED** — HTTP 403 on all automated requests (homepage, directory
  path, robots.txt). Returns Forbidden for non-browser UAs. Not viable without
  browser automation or residential proxy.
- Record estimate: ~6,000 (per indexed snippet)

### AEDAF (Asociación Española de Asesores Fiscales) ✅ SELECTED
- URL: https://www.aedaf.es/es/relacion-de-asociados
- **STATUS: VIABLE**
- robots.txt: returns HTTP 404 — no file → all paths permitted.
- Auth / captcha / Cloudflare: none.
- Records: 666 confirmed ("Mostrando 1 a 25 de 666").
- Endpoint: listing `?page=N` (0-indexed, 25/page, ~27 pages) +
  detail `/detalle/{ID}` per member.
- Fields: name, qualification/degree, email, phone, address,
  city, province, postal code, website.
- Category: `fiscal` — AEDAF is Spain's premier professional tax-advisor
  association (Ley IRPF compliance advisors, founded 1967).
- Cadence: monthly (slow-moving rolls).

### CONAIF (Confederación Nacional de Instaladores y Fluidos)
- URL: https://www.conaif.es/asociaciones/
- **STATUS: NOT VIABLE** — directory only lists 74 member associations, not
  individual installer companies. Would require crawling 74 separate regional
  federation sites.

### Registro de Gestores Administrativos
- URL: https://registro.consejogestores.org/
- **STATUS: BLOCKED BY ROBOTS.TXT** — `Disallow: /*?*` blocks all parameterised
  URLs including all pagination and filter params. The entire directory is
  disallowed.

## Decision
AEDAF selected. Scraper at `src/sources/aedaf-es.ts`, source key `aedaf-es`,
category `fiscal`. 666 records is above the 500-record threshold; data quality
is high (strict admission criteria = verified professional tax advisors).
