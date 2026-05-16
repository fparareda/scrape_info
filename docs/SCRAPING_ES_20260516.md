# ES Scraper Research — 2026-05-16

## Candidates Evaluated

### 1. CONAIF (conaif.es) — fontanería/gas/HVAC federation

**Status: Not viable as a direct installer registry.**

- robots.txt: allows crawling (Yoast blanket permit).
- The `/Asociaciones/` page lists **74 associations** with name, phone, email, website — each association is itself a trade body, not an installer company.
- No public directory of the 20,000+ member installer companies is exposed.
- Association count (74) is too low for our ≥500 target.
- Verdict: rejected — only 74 records, and they are associations not companies.

### 2. FENIE (fenie.es) — electricistas federation

**Status: Not viable as a direct installer registry.**

- robots.txt: `Disallow:` empty = allow all. Sitemap present.
- `fenie.es/directorio-de-asociaciones/` lists ~100 regional electrical installer associations.
- The **EIC (Empresa Instaladora Certificada)** system at `eic.fenie.es` timed out during research — likely Cloudflare protected.
- Association count (~100) is below threshold even if accessible.
- Verdict: rejected — too few records; EIC subdomain unreachable.

### 3. Ministerio de Industria — Registro Integrado Industrial (RII)

**Status: VIABLE — implemented.**

URL: `https://sede.serviciosmin.gob.es/es-ES/datosabiertos/catalogo/consulta-rii-instaladores-gas`

Direct download: `https://www6.serviciosmin.gob.es/Aplicaciones/OpenDataModule_AC202101/UbicacionRIII/Consulta%20RII%20Instaladores%20Gas.xlsx`

**Pre-flight checks (2026-05-16):**

1. **robots.txt**: No robots.txt on `www6.serviciosmin.gob.es` (404 → permit by absence). The Ministry's sede domain (`sede.serviciosmin.gob.es`) also returns 404 for /robots.txt. Open-data portal explicitly states reutilización is permitted.
2. **Data format**: Single XLSX download. No captcha, no login, no Cloudflare. Direct HTTP GET returns the file immediately.
3. **Record count**: 26,466 rows (one header). ~25,203 unique companies after deduplication (same company appears for each habilitación category A/B/C).
4. **Contact fields**: name (Titular/Razón social), NIF (Documento), phone (Teléfono), email (Correo electrónico), address (Dirección), postal code (Código postal), municipality (Municipio), province (Provincia), CCAA.
5. **Contact coverage**: 20,489 companies with phone (81%), 10,688 with email (42%), 10,523 with both phone + email + address (42%).
6. **Cloudflare/captcha**: None detected.
7. **License**: Datos abiertos — reutilización permitida per Ministry's open-data policy (aviso legal `https://sede.serviciosmin.gob.es/es-ES/Paginas/aviso.aspx#Reutilizacion`).
8. **Update frequency**: Daily.

**Category mapping**:
- `fontaneria` — Gas installer companies (the canonical gas/plumbing installer registry in Spain)

**Why this is the best available source**:
- Official government open data (Ministry of Industry) = highest trust / verified authority
- 25k+ unique installer companies across all 50 Spanish provinces
- 80%+ phone coverage, 42%+ email coverage + full address
- Single-file bulk download — no pagination, no rate-limiting concerns
- Daily-updated

### 4. RII Division A / Division B CSVs (also from Ministerio de Industria)

Both Division A and Division B CSVs are available as bulk downloads:
- Division A: ~66k rows. Fields: Denominación, Empresa, CNAE, Municipio, Provincia — NO phone/email/address.
- Division B: ~97k rows. Has Habilitación (Baja Tensión = 57k rows, Gas = 3k, Fontanería = 1.5k, Instalaciones Térmicas = 6k). But NO phone/email/address fields.

The Division B CSV is useful for enrichment (volume, licence number) but the Gas XLSX is the only one with full contact data.
