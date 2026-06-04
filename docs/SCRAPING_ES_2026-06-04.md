# ES Scraper Pre-flight — 2026-06-04

**Result: SKIPPED — no viable new source found within current taxonomy.**

## Research summary

Three categories of candidates investigated:

### 1. Abogado (lawyers)
- **CGAE** (`cgae.ts`) already covers national lawyers: a federation fan-out over 83 provincial
  colegios via the Ventanilla Única mandate (Ley 17/2009). National coverage is complete.
- Checked Huesca bar association (`icahuesca.es/directorio/abogados-ejercientes-colegiados/`):
  WordPress-based, ~400–600 records, "Mostrar más" pagination is AJAX-only (JS rendering
  required). Below 500-record threshold for smallest provinces; not viable.

### 2. Mecanica (automotive workshops)
- **Junta de Andalucía RIIA** (Registro Integrado Industrial de Andalucía): talleres de
  reparación de vehículos are registered in the RIIA, but there is NO public-facing buscador
  or downloadable dataset. The portal exposes only procedural/regulatory pages.
  datos.gob.es returns zero results for "talleres". **NOT ACCESSIBLE.**
- CCAA talleres already covered: Madrid, Galicia, Cataluña (scrapers live), plus open PRs
  for Castilla y León (jcyl-instaladoras-es) and RII División A talleres.

### 3. Fiscal / Cerrajero
- `cerrajero` (locksmiths) has no regulated professional colegio in Spain. Only accessible
  via generic directories (already covered by BORME, habitissimo-es).
- `fiscal` gap (asesores fiscales): REAF-REGAF (Registro de Economistas Asesores Fiscales)
  is part of the Consejo General de Economistas. Their member directory requires colegio
  login. Not accessible without auth.

## Recommendation

The main categories not yet well covered in Spain are:
- **cerrajero**: No national licensing body. Future option: scrape business-directory
  specifically filtered to CNAE 4322 (cerrajería) from datos.gob.es/SABI.
- **Andalucía talleres**: Junta de Andalucía may open the RIIA in a future datos.gob.es
  release. Monitor portal.

Next scout run should focus on checking whether the Junta de Andalucía RIIA has been
published as an open-data dataset.
