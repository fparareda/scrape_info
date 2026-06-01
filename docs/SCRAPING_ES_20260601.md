# Scraping ES — 2026-06-01

## Target chosen: RASIC Cataluña — Instal·ladors industrials

### Source

| Field | Value |
|---|---|
| URL | `https://analisi.transparenciacatalunya.cat/resource/qcrr-stew.json` |
| Dataset ID | `qcrr-stew` |
| Publisher | Generalitat de Catalunya — RASIC (Registre d'Activitats i Serveis d'Inspecció de Catalunya) |
| API type | Socrata JSON/CSV (open, no auth) |
| Robots.txt | Only blocks `/browse?*`; `/resource/` paths are allowed. `Crawl-delay: 1`. |
| Record count | ~19,235 active records |
| Slug | `rasic-instaladores-cat` |
| Env flag | `PROLIO_RUN_RASIC_INSTALADORES_CAT=true` |

### Categories mapped

| Flag column | Value | CategoryKey |
|---|---|---|
| `bt_installacions` | Sí | `electricidad` |
| `gas` | Sí | `fontaneria` |
| `ite_installacions_term` | Sí | `hvac` |
| `pci_sist_deteccio_alarma` | Sí | `cerrajero` |

One company can map to multiple categories. A record is emitted once per matching category (distinct sourceId per category).

### Why this source

- First government-backed `cerrajero` source for ES (~800 alarm-system installer records, >500 minimum).
- Also adds Cataluña-specific `electricidad` / `fontaneria` / `hvac` coverage with phone numbers and CIF — richer than the national RII CSV.
- Different dataset from `rasic-talleres-cat.ts` (vehicle workshops, `ebyt-8dme`).

### Alternatives investigated and blocked

| Source | Reason blocked |
|---|---|
| datos.gob.es cerrajeros | Imperva WAF — 403 for all programmatic access |
| interior.gob.es security registry | Cloudflare — 403 `cf-mitigated: challenge` |
| ICAB (Barcelona lawyers) | robots.txt explicitly disallows professional directory |
| notariado.org | robots.txt disallows `/es` for all user-agents |
| ICAV (Valencia lawyers) | JS-driven form, `action="#"`, POST redirects to homepage |
| psicolcat.com | ECONNREFUSED |
| solucionaf.com cerrajeros | Only 127 records (below 500 minimum) |
| RII Division A CNAE 802 | Only 16 security records (below 500 minimum) |
| RII Division B | No cerrajero habilitación type |
