# Revision: drop sources that need residential IPs

This document supersedes the residential-IP-dependent recommendations in
[type-b-sources.md](type-b-sources.md) and [type-c-sources.md](type-c-sources.md).
All workers run on Vercel / GitHub Actions / Supabase Edge — datacenter
IPs — so any source that blocks AWS/GCP/Azure ranges is dead on arrival.

## Sources removed from the plan

| Source | Reason | Status |
|---|---|---|
| `paginas_amarillas` (ES) | Cloudflare WAF rejects datacenter | already disabled (`PROLIO_SCRAPE_PA=true` only) |
| `paginasamarillas` enum alias | same | same |
| **SEP RNP MX cédulas** | datacenter blocks; site times out | **dropped** |
| **CSN annuaire-notaires.fr** | not reliably reachable; timed out from datacenter | **dropped — replace with SIRENE** |
| `competitor-na` (homestars/trustedpros) | Cloudflare WAF | already disabled by default |
| `homeadvisor` / `thumbtack` | Cloudflare WAF | already disabled by default |

## Substitutes that DO work from datacenter

### FR notario (replaces CSN annuaire-notaires.fr)

**SIRENE-INSEE** already exists as a scraper. Notaries are NAF 6910Z
(Activités juridiques) with specific sub-codes. Extend `sirene-insee.ts`
to emit a `notario` category when the NAF code matches notarial offices.
~7k offices, fully covered by SIRENE's open dataset (datacenter-friendly,
no captcha). No new scraper required — just a category mapping update.

### MX abogado / enfermería / farmacia (replaces SEP RNP)

**DENUE-MX** already exists and is bulk-friendly. SCIAN codes:
- abogado: 541110 (Bufetes jurídicos)
- enfermería: 621112 + 622112 (consultorios + servicios de enfermería)
- farmacia: 464111 (Farmacias sin minisuper) + 464112
- veterinario clínica: 541940

DENUE returns ~1M businesses; filtering by SCIAN gives the per-category
volumes natively. Update `denue-mx.ts` to map these SCIANs to our
category keys. No new scraper needed.

For **personas físicas** (cédulas individuales), use:
- **IMSS-DIRECTORIO** (already exists) for medical personnel
- **COFEPRIS** licenses (already covers farmacias, can extend)
- For lawyers/nurses without commercial entity → accept the gap;
  there is no datacenter-accessible registry for personas físicas in MX

### US categories (no change needed)

NCEES, NCARB, Nursys, FSBPT, ABA, NPI, CMS PECOS — all publish open
data accessible from datacenter IPs. Already covered in the plan.

### CA categories (no change needed)

Provincial colleges (RCDSO, CDSBC, ADA+C, etc.) and trade boards all
have public registries reachable from datacenter. Already in scope.

### ES categories blocked

- **abogado** — CGAE has been historically datacenter-friendly. Keep
  in scope (already in `cgae.ts`).
- **cerrajero** — drop paginas_amarillas, fall back to OSM Overpass
  `craft=locksmith` (already covered by `osm.ts`). ~1k entries; small
  but honest.
- **enfermeria / farmacia** — CGE + CGCOF have public buscadores;
  unverified for datacenter blocking but plausible. Keep in scope,
  flag for verification.

## Updated roadmap

Remove from prior plan:
- ~~Sprint 2: SEP-RNP MX~~ → **dropped**. Use DENUE-MX SCIAN extension.
- ~~Sprint 3: CSN-FR notaires~~ → **dropped**. Use SIRENE NAF 6910Z.
- ~~Long-tail: paginas_amarillas~~ → **dropped permanently**. OSM only.

New simplified roadmap (post #50/#51/#52):

| Sprint | Action | Source(s) |
|---|---|---|
| K | Extend `denue-mx.ts` to emit `abogado` (SCIAN 541110), `enfermeria` (621112+622112), `farmacia` (464111+464112) | existing scraper, new category mapping |
| L | Extend `sirene-insee.ts` to emit `notario` (NAF 6910Z notariales) | existing scraper, new category mapping |
| M | Add NCEES License Search scraper for US `ingenieria` | new file |
| N | Add NCARB Directory scraper for US `arquitecto` | new file |
| O | Add Nursys for US `enfermeria` | new file |
| P | Add FSBPT for US `fisioterapia` | new file |
| Q | Provincial dentistry colleges CA (RCDSO already exists; 8 more) | new files following `odq.ts` pattern |
| R | NASBA CPAverify (federal US `fiscal`, 50-state unified API) | new file |
| S | CGAE / CGE / CGCOF ES (validate they accept datacenter requests first) | new files following `colegios/` pattern |
| T | Delete `csn-notaires-fr.ts` scaffold (superseded by SIRENE NAF mapping) | cleanup |

Sprints K and L are the highest ROI: each one extends an existing
scraper to close 3+ TYPE_B gaps, no new HTTP fingerprint, no risk.
