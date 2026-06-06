# ES Scraper Expansion — 2026-06-06

## Candidates Researched

### 1. Catalonia RASIC — Industrial Installation Companies ✅ PICKED

**Dataset:** Empreses d'instal·lació, manteniment, reparació i operació
d'instal·lacions i productes industrials (RASIC dataset `qcrr-stew`)

**URL:** https://analisi.transparenciacatalunya.cat/Economia/Empreses-d-instal-laci-manteniment-reparaci-i-oper/qcrr-stew

**API endpoint:** `https://analisi.transparenciacatalunya.cat/resource/qcrr-stew.json`

**robots.txt:** ALLOWED. analisi.transparenciacatalunya.cat robots.txt disallows only
`/OData.svc/`, `/api/odata/`, `/api/collocate*` — `/resource/` and `/api/views/` paths
are fully open. Crawl-delay: 1 second.

**Technology:** Socrata open-data portal. Bulk JSON/CSV via standard SoQL, no auth,
no Cloudflare, no captcha.

**Record count:** 19,235 active industrial installation companies.

**Fields available:**
- `titular` — company/person name
- `adreca_agrupada` — full street address
- `municipi` — municipality
- `codi_postal` — postal code
- `prov_ncia` — province (Barcelona, Girona, Lleida, Tarragona)
- `telefon_mobil` — mobile phone
- `n_mero_de_rasic` — RASIC registration number (licence)
- `estat_registre` — Alta/Baixa (active/inactive)
- `bt_installacions` — low-voltage electricity (Sí/No)
- `ite_installacions_term` — thermal/HVAC (Sí/No)
- `fred_industrial` — industrial refrigeration (Sí/No)
- `gas` — gas installations (Sí/No)
- Plus 15+ fire protection / elevator / high-voltage specialty columns

**CategoryKey mapping:**
- `bt_installacions` → `electricidad`
- `ite_installacions_term` / `fred_industrial` → `hvac`
- `gas` → `fontaneria`
- Default → `electricidad`

**Geographic scope:** Catalonia (4 provinces): fills a gap since the existing
`rasic-talleres-cat` covers vehicle repair workshops (`ebyt-8dme`), not installation
companies (`qcrr-stew`). These are distinct datasets.

**Licence:** CC-BY (Catalan Government transparency open data).

**Scraper slug:** `rasic-instaladores-cat`
**Source file:** `src/sources/rasic-instaladores-cat.ts`
**Cron:** Monthly (1st of month 03:30 UTC) — RASIC rolls update monthly.

---

### 2. RII (Registro Industrial España) — Blocked

**URL:** https://industria.serviciosmin.gob.es/RII/consultaspublicas/
**Verdict:** ASP.NET form; robots.txt disallows major crawlers. Skipped.

### 3. National installers (FENIE, CONAIF) — Fragmented

No single public national member list found. Regional directories exist
(~400 for Madrid Agremia, below 500 threshold) or are private.

### 4. UGCA/ANPIER cerrajeros — Not found

No national public registry for locksmiths identified.
