# ES Scraping Pre-flight — 2026-05-13

Research for new verifiable Spanish professional-college directory.
Uncovered categories targeted: fisioterapia, veterinario, psicologia, dentista.

---

## Candidates researched

### 1. CGCOF — Consejo General de Colegios de Fisioterapeutas
- **URL investigated:** https://www.cgcof.es
- **robots.txt:** cgcof.es redirects (301) to https://www.farmaceuticos.com/ (pharmacists, not physios). The cgcof.es domain has been pointed at the pharmacists council website.
- **Verdict:** BLOCKED / WRONG SITE. The domain cgcof.es no longer serves the fisioterapia council. No alternative URL for the fisioterapia national council found that exposes a public member directory. aefi.net (Asociación Española de Fisioterapeutas) is an association without a member lookup.

### 2. COEV / CGCPVE — Consejo General de Colegios Veterinarios de España
- **URL investigated:** https://www.colvet.es
- **robots.txt:** `Sitemap: https://www.colvet.es/sitemap.xml` — no explicit Disallow for any path. Path is allowed.
- **Directory page:** https://www.colvet.es/buscador — returns a general site-search form, NOT a member directory. The Colegios page (/es/13-CGCPVE/30-Colegios) only lists the individual provincial colegios with links. No national member search found.
- **Verdict:** INSUFFICIENT — no national member lookup available.

### 3. COP — Consejo General de la Psicología de España
- **URL investigated:** https://www.cop.es
- **robots.txt:** Allows most paths; disallows /admin/, /tmp/, /correas/, one specific member page.
- **Directory page:** /colegiados/ returns 404 (IIS). /index.php?page=colegios shows a map linking to individual provincial colegios (e.g., copmadrid.org, copbizkaia.org, etc.). No national search.
- **Verdict:** INSUFFICIENT — only decentralised per-region lookups; no national API.

### 4. CGCOD — Consejo General de Colegios de Odontólogos y Estomatólogos (now: Consejo General de Dentistas)
- **Primary URL:** https://www.consejodentistas.es
- **robots.txt:** `Disallow: /wp-content/uploads/`, `Disallow: /*.pdf$` — directory not blocked.
- **Sitemap inspection:** No "encuentra-tu-dentista" page found in production sitemap. The Elementor page for /informacion-publica/encuentra-tu-dentista returns 404.
- **Secondary URL discovered:** https://guiadentistas.es (linked from consejodentistas.es/consejo-general/colegios-oficiales/)
  - **robots.txt:** 404 (no robots.txt) → no restrictions, all paths allowed by default.
  - **Page structure:** Plain HTML site, Bootstrap + jQuery DataTables. Server-side JSON endpoint at `/colegios/serverFO.php`.
  - **JSON endpoint test:** `GET /colegios/serverFO.php?draw=1&start=0&length=100` returns JSON with `recordsTotal: 52289`, `recordsFiltered: 44355`. Each record: `[numcol, nombre, apellido1, apellido2, rowId]`. Province is encoded in first 2 digits of numcol (e.g., "28" = Madrid, "08" = Barcelona).
  - **Auth / WAF:** No login, no Cloudflare, no captcha. Polite UA accepted.
  - **Record count:** 44,355 active colegiados (filtered); 52,289 total.
  - **Category mapping:** `dentista` (CategoryKey).
  - **Detail page:** `/detail.php?numcol=04002206` returns address + phone. Not fetched in bulk (too slow), but colegiado number allows province inference.
- **Verdict:** VIABLE — best candidate found.

---

## Decision

**Selected:** `guiadentistas.es` — CGCOD / Consejo General de Dentistas — dentista category.

- robots.txt: no file (no restrictions)
- Data API: `/colegios/serverFO.php` — server-side DataTables JSON, paginated, no auth
- Records: ~44,355 active dentists across all 52 Spanish provinces/territories
- Province → city: derived from colegiado number prefix (01–52 = standard Spanish province codes)
- Auth: none
- Captcha: none
- Cloudflare: none
- Login: none
