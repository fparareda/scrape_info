# Spain scraper scout — 2026-06-21

## Summary

No new viable source identified for this run. All obvious candidate categories
are already covered by existing scrapers or national registries are blocked
from datacenter IPs.

## Candidates evaluated

### 1. Ministerio del Interior — Registro Nacional de Empresas de Seguridad Privada

- **Category**: `cerrajero`
- **URL**: https://www.interior.gob.es/opencms/es/servicios-al-ciudadano/tramites-y-gestiones/seguridad/empresas-de-seguridad/
- **Verdict**: ❌ BLOCKED — HTTP 403 from datacenter IP. No public searchable or
  downloadable directory of security companies. Statistical annuals on datos.gob.es
  contain aggregate counts, not individual company records.
- **Alternatives investigated**: Cataluña's Gencat list (network error); Sede
  Electrónica Policía Nacional (informational page only).

### 2. CGPE Directorio de Procuradores (directorio.cgpe.es)

- **Category**: `abogado`
- **URL**: https://directorio.cgpe.es/
- **Records**: ~9,827 procuradores nationally
- **Verdict**: ❌ ALREADY IMPLEMENTED — `src/sources/cgpe-procuradores.ts` and
  `PROLIO_RUN_CGPE_PROCURADORES=true` are already in the codebase.

### 3. Consejo General de Graduados Sociales (graduadosocial.org)

- **Category**: `fiscal`
- **URL**: https://www.graduadosocial.org/
- **Verdict**: ❌ ALREADY IMPLEMENTED — `src/sources/graduados-sociales-es.ts`
  exists in the codebase.

## Next steps

For a future `cerrajero` national source in ES:
- Monitor the Ministerio del Interior for an open-data release of the
  "Registro de Empresas de Seguridad Privada" (currently behind a 403).
- Consider RIPCI (Registro de Instaladores de Protección Contra Incendios)
  under MINCOTUR — fire protection installers that partially overlap with
  security/locksmith work.
- Regional registries (Cataluña RASIC already covered) may be the only viable
  path until the national registry opens.
