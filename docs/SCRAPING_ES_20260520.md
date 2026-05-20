# ES Scraper Research — 2026-05-20

Research conducted to find one new scrapeable web source for verifiable
professional-contact records in Spain, restricted to the existing taxonomy.

## Candidate categories investigated

Under-covered ES categories evaluated in priority order:
**cerrajero → fiscal → extranjeria → carpinteria**

---

## 1. Cerrajero

### 1a. ANSEC (ansec.es)
- **Result: NOT VIABLE** — Domain shows SSL certificate errors (unable to
  verify certificate). Could not fetch robots.txt or any page.

### 1b. FECSA / APECS (apecs.es)
- **robots.txt:** `Disallow:` empty = allows all.
- **Directory:** `apecs.es/buscar-cerrajeros-en-apecs/` returns server-rendered
  HTML with 80 members across 14 pages.
- **Result: REJECTED — only ~80 members, below the 500-record threshold.**

### 1c. UCES (uces.es)
- **robots.txt:** allows most paths (only wp-admin blocked).
- **Directory:** `uces.es/encuentra-tu-cerrajero/` uses JavaScript/AJAX
  (province dropdown + spinner GIF). Results load dynamically; total shown
  as `--` until form submitted.
- **Result: REJECTED — AJAX-driven, not accessible via plain HTTP.**

### 1d. ACSE (acse.es)
- **Directory:** Lists "+50 empresas asociadas" (50+ companies).
- **Result: REJECTED — only ~50 members, well below threshold.**

**Cerrajero conclusion:** No national locksmith body in Spain has a public,
server-rendered directory with ≥500 records. All candidates either have too
few members (APECS 80, ACSE 50) or are AJAX-gated (UCES). Category remains
not viable for this pass.

---

## 2. Fiscal — Consejo General de Economistas de España (CGE)

### 2a. Central buscar-colegiados (economistas.es)
- **robots.txt:** HTTP 403 from datacenter IPs — cannot verify.
- **Result: REJECTED — blocked at datacenter level.**

### 2b. REAF directorio-de-miembros (reaf.economistas.es)
- **robots.txt:** HTTP 403.
- **Result: REJECTED — blocked at datacenter level.**

### 2c. Individual colegios de economistas

Each of Spain's ~48 colegios de economistas is required by Ley 17/2009
(Ventanilla Única) to publish a public padrón of its members. Research
identified four colegios with accessible, server-rendered, paginated
directories:

| Colegio | Domain | Members | robots.txt | Pattern |
|---------|--------|---------|------------|---------|
| Valencia (COEV) | coev.com | 4,121 | Allow all | ?page=N |
| Sevilla | economistas-sevilla.com | 1,272 | Allow (60s delay) | ?letter=A-Z |
| A Coruña | economistascoruna.org | ~1,000 | Allow /colegiados_buscador | ?f[0]=glosario:X&page=,N |
| ECOVA (Valladolid/Palencia/Zamora) | ecova.es | ~980 | Allow .html | /colegiados_en_activo_N.html |

**Combined: ~7,373 economist records across 4 colegios → well above 500.**

All four pass the viability criteria:
- No Cloudflare / captcha / login required
- Server-rendered HTML (not AJAX)
- ≥500 records individually or collectively
- robots.txt allows the directory path

**Taxonomy mapping:** `fiscal` — Economistas in Spain function primarily as
tax advisors (asesores fiscales), accountants, and auditors. CGE's REAF
sub-registry (6,000+ members) explicitly covers "Economistas Asesores
Fiscales." This is the correct existing category.

### 2d. Madrid CEMAD (cemad.es)
- **"Encuentra tu economista"** at `/ventanilla-unica/encuentra-tu-economista/`
  uses a province dropdown + AJAX spinner. No static HTML rendered.
- **Result: REJECTED — AJAX/B status, cannot fetch via plain HTTP.**

---

## 3. Extranjería

CGAE (already implemented) routes immigration-specialist lawyers to
`extranjeria` when identified. No separate immigration-lawyer college or
public registry exists in Spain beyond CGAE's coverage. Skipped.

---

## 4. Carpintería

No national carpentry guild or building-trade register with a public,
accessible directory was found. Regional guilds (Gremio de la Madera
Sabadell, etc.) have too few members and are mostly static web pages
without machine-readable member lists. Skipped.

---

## Decision

**Selected: Consejo General de Economistas de España (CGE) federation fan-out**
- **Slug:** `cge-economistas-es`
- **Category:** `fiscal`
- **Implementation:** 4 active colegios, each with a bespoke extractor
  matching its pagination pattern. Federation pattern follows `_consejo-vu-utils.ts`.
- **Expected records:** ~7,400 per full run (4 colegios × avg ~1,850 each).
- **Schedule:** Monthly (annual college rolls, slow-moving data).
