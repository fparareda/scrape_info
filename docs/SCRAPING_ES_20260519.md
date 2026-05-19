# ES Scraper Scout — 2026-05-19

## Candidate evaluated

### ICOMEM — Ilustre Colegio Oficial de Médicos de la Comunidad de Madrid

| Field | Value |
|---|---|
| URL | https://www.icomem.es/ventanilla-unica/buscador-colegiados |
| Category | `medicina` |
| robots.txt | ALLOWED — `/ventanilla-unica/` not in any Disallow |
| Record count | ~56,660 (2,783 pages × 20 records) |
| Access method | Server-rendered HTML (Joomla, Ventanilla Única module) |
| Pagination | `/ventanilla-unica/buscador-colegiados/pag/{N}` (path-based, no session) |
| Fields | núm_col (9-digit licence), nombre (full name), activo (Sí/No) |
| Profile fields | address, phone, email, website at `/buscador-colegiados/{id}/{hash}` |
| Blockers | None |
| Verdict | **VIABLE** |

### Why chosen

- `medicina` has zero national ES coverage (CGCOM consultapublica is a JS SPA
  returning 403 on subpaths from datacenter IPs; ICOMEM is the clean
  server-rendered alternative).
- Largest single provincial medical college in Spain (Madrid province alone
  has ~57k colegiados; national total CGCOM is ~276k across 52 colleges).
- Zero open PRs targeting ES medicina at the time of this scout.
- Consistent with Ley 17/2009 Ventanilla Única pattern used by CGCFE, CGAE,
  CSCAE, CGPE, CGN, VUCOLVET, CGCOO already in the repo.

### Implementation notes

- City: `madrid` (ICOMEM scope is Madrid province only).
- Profile pages not scraped in first pass to stay polite (~56k extra requests).
- Future expansion: the same scraping pattern can be replicated across the
  other 51 provincial colleges linked from cgcom.es/colegios-mapa; each uses
  the same Joomla VU module with `?page=N` or `/pag/{N}` pagination.

### Scraper

`src/sources/icomem-medicos-es.ts`  
Env flag: `PROLIO_RUN_ICOMEM_MEDICOS=true`  
Limit: `PROLIO_ICOMEM_MEDICOS_LIMIT` (default 10 000)  
Workflow: `scrape-icomem-medicos-es.yml` — monthly, day 7 03:00 UTC

### Rejected candidates

| Candidate | Reason |
|---|---|
| CGCOM consultapublica (national) | JS SPA, 403 on subpaths from datacenter IPs |
| Consejo General de la Abogacía (busca-abogado) | JS SPA requiring session tokens |
| IACM / ICAM abogados Madrid | Cloudflare protected |
