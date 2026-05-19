# Plan: fix the cross-country slug problem at the root

## Problema actual (recap)

Hoy hay **3 capas** que cooperan para evitar el bug:

1. **DB schema** (Sprint 0 ya aplicado): `cities` PK `(country, slug)`, `professionals.city_country` con FK composite. **Acepta NULL en city_country** porque MATCH SIMPLE — eso permite escrituras viejas pasen.
2. **Sink fallback** (`SOURCE_COUNTRY` map en `src/source-country.ts`): si un `ScrapedProfessional` no declara `country`, el sink lo deduce del `source` literal. Mapa estático de 105 sources.
3. **Scrapers**: 125 de 160 ya ponen `country` en `metadata.country` (informativo), pero **NINGUNO** lo pone como campo top-level del `ScrapedProfessional`. El sink se apoya en el mapa.

Esto **funciona pero es frágil**:

- Si añades un scraper nuevo y olvidas registrarlo en el mapa, el sink dropea la fila silenciosamente (`droppedCountry`).
- `country` sigue siendo opcional en el tipo → typescript no avisa.
- Los scrapers que usan `slugify(cityName)` pueden generar slugs que existen en OTRO país (la causa raíz original): si un scraper US genera `slugify('Paris')='paris'` y `cities` sólo tiene `(FR, paris)`, el slug se acepta sólo cuando el resolver compara con country.
- Sources multi-país (google_places, osm, wikidata, paginas_amarillas, gleif…) que omitimos del mapa **deben** declarar `country` per-row — pero NO está enforced.

## Objetivo

Que sea **imposible** insertar una fila con país equivocado, sin dependencias en mapas estáticos manuales.

Tres invariantes a cumplir:

| # | Invariante | Enforced por |
|---|---|---|
| 1 | Toda fila tiene `city_country` no NULL | Schema constraint NOT NULL |
| 2 | El `(city_country, city_slug)` referencia una fila real de `cities` | FK composite (ya está) |
| 3 | Todo scraper declara `country` explícitamente en cada `ScrapedProfessional` | Type required + lint |

## Fases (10 sprints aprox)

### Sprint A — Backfill remanente + 2ª pasada (1-2 días)

**Objetivo**: que `city_country IS NULL` sea **0 hoy** y se mantenga así durante el sprint.

1. Re-ejecutar `scripts/sprint-0-rpc-loop.mjs` con `CHUNK=2000` en horario de baja carga. ~10-30 min.
2. Verificar: `SELECT COUNT(*) FROM professionals WHERE city_country IS NULL` debe ser 0.
3. Configurar **GitHub Actions workflow `audit-city-country-nulls.yml`** que falle si aparecen NULLs (corre cada 6h). Eso da señal temprana de regresiones.

**Salida**: trazabilidad de que estamos a 0 NULLs.

### Sprint B — Cerrar Sprint 1 (1 día)

**Objetivo**: completar el re-geocode de las 3 sources que quedaron parciales.

1. `scripts/sprint-1-address-loop.mjs` con `CHUNK=2000` en horario baja carga para terminar datos-gob-es / rcdso / oaq.
2. Verificar dispersión: top-1 city share <40% en (ES, fiscal) y (CA, dentista).

### Sprint C — `country` required en el tipo (3-5 días)

**Objetivo**: forzar a cada scraper a declarar `country` top-level. typescript hace el trabajo.

1. Cambiar `src/types.ts`:
   ```ts
   country: "ES" | "CA" | "US" | "FR" | "MX";  // remove the `?`
   ```
2. `npm run typecheck` lista los ~160 sources que no compilan.
3. Auto-fix script `scripts/codemod-add-country.mjs`:
   - Para cada source con `metadata.country: 'XX'`, promover `country: 'XX'` al top-level del `ScrapedProfessional` literal.
   - Idempotente, dry-run primero.
4. Para los sources sin `metadata.country` (35 archivos), revisión manual: deducir país del nombre del archivo (ej. `cogiti-ingenieros.ts` → ES), añadir `country`.
5. Eliminar `SOURCE_COUNTRY` map → ahora el sink usa **sólo** `record.country` (sin fallback).
6. `npm run typecheck` verde.

**Salida**: typescript hace imposible olvidar `country` en un scraper nuevo. El mapa estático ya no es load-bearing.

### Sprint D — Helper `buildCitySlug(country, cityName)` (2 días)

**Objetivo**: que cada scraper use el mismo proceso de city resolution, country-aware.

1. `src/normalise.ts` añade:
   ```ts
   export function buildCitySlug(
     country: Country,
     cityName: string | null | undefined,
   ): { citySlug: string; provinceFallback: boolean } {
     if (!cityName?.trim()) return { citySlug: "", provinceFallback: true };
     return { citySlug: slugify(cityName), provinceFallback: false };
   }
   ```
   El helper **no** valida contra `cities` (eso lo hace el sink). Sólo normaliza.
2. Codemod `scripts/codemod-buildCitySlug.mjs` que reemplaza `citySlug: slugify(rawCity)` o `citySlug: slugify(city.name)` patrones → `citySlug: buildCitySlug(country, rawCity).citySlug`.
3. Para sources que sólo tienen provincia, `citySlug: ""` + `metadata.province_slug: slugify(province)` + `metadata.location_granularity: "province"`.

**Salida**: una sola función canónica. Más fácil añadir un scraper sin pensar.

### Sprint E — DB hardening: `city_country NOT NULL` (1 día)

**Objetivo**: que el schema rechace filas sin país.

1. Ejecutar `ALTER TABLE professionals ALTER COLUMN city_country SET NOT NULL`. Sólo después de confirmar Sprint A llevó a 0 NULLs.
2. Cambiar el FK a `MATCH FULL` (rechaza `(NULL, slug)` pero acepta `(country, NULL)` para province-only):
   ```sql
   ALTER TABLE professionals DROP CONSTRAINT professionals_city_fkey;
   ALTER TABLE professionals ADD CONSTRAINT professionals_city_fkey
     FOREIGN KEY (city_country, city_slug) REFERENCES cities(country, slug)
     MATCH SIMPLE;  -- keep MATCH SIMPLE so NULL slug works
   ```
   (MATCH SIMPLE ya está. La NOT NULL en city_country + MATCH SIMPLE da la garantía que queremos.)
3. CHECK constraint adicional: si `city_slug IS NULL` debe haber `metadata->>'province_slug'` no NULL.

### Sprint F — Coverage seed gigante (3-5 días)

**Objetivo**: las ~1,610 ciudades actuales son ridículas vs ~70k reales. Seed completo previene `dropped X rows with unseeded city_slug` masivo.

1. Bajar CSVs de catalogos oficiales:
   - ES: INE Relación de Municipios (8,131)
   - MX: INEGI Catálogo (2,464)
   - FR: INSEE COG (34,955)
   - US: Census Gazetteer (19,495)
   - CA: StatCan CSubs (5,162)
2. Script `scripts/seed-cities-bulk.mjs` que normaliza y inserta `(country, slug, name, lat, lng, region)` con `ON CONFLICT DO NOTHING`. Una vez.
3. Verificar: `SELECT country, COUNT(*) FROM cities GROUP BY country`.

**Salida**: deja de dropear filas por slug no seeded.

### Sprint G — Test unitario por scraper (3 días)

**Objetivo**: que un test demuestre que cada scraper produce `country` válido.

1. `tests/sources/all-sources-emit-country.test.ts`:
   ```ts
   for (const file of glob("src/sources/*.ts")) {
     it(`${file} emits records with country`, () => {
       const records = mockRunSource(file);
       for (const r of records)
         expect(["ES","CA","US","FR","MX"]).toContain(r.country);
     });
   }
   ```
2. Wire into `npm test` en CI.

### Sprint H — Lint rule custom (1 día)

**Objetivo**: error si alguien hace `record.country = undefined` por error.

1. ESLint custom rule en `eslint-rules/require-country-on-scraped-professional.js`:
   - Detecta object literals asignados a `ScrapedProfessional` o pushed a un array tipado así.
   - Requiere clave `country`.
2. Configurar en `.eslintrc`.

(Sprint G y H se solapan; G es el fallback más fiable, H es el feedback rápido en IDE.)

### Sprint I — Documentar y comunicar (0.5 día)

1. Añadir sección "Cómo añadir un scraper" en `README.md` con ejemplo mínimo:
   ```ts
   export const myScraper: ScraperSource = {
     name: "my-source",
     async fetch(target) {
       return [{
         source: "my-source",
         sourceId: "...",
         name: "...",
         categoryKey: "...",
         country: target.country,  // ← REQUIRED
         citySlug: buildCitySlug(target.country, rawCity).citySlug,
         // ...
       }];
     },
     enabled() { return true; },
   };
   ```
2. Eliminar el SOURCE_COUNTRY map del repo (ya no hace falta) y borrar las referencias en documentación.

### Sprint J — Limpieza final (1 día)

1. Auditar el dashboard `/admin/coverage` (si existe) para confirmar la matriz ciudad×oficio se ha re-poblado bien.
2. Re-correr `scripts/audit-city-concentration.mjs` y comparar con la auditoría de hace dos días. **Top-1 city share medio** debería bajar de ~50% a <30% en las categorías Tipo A.
3. Borrar scripts one-shot (`sprint-0-*`, `sprint-1-*`) o moverlos a `scripts/archive/`.

## Cronograma sugerido

| Día | Sprint | Bloquea a |
|---|---|---|
| 1 | A + B (backfill remanente) | C |
| 2-3 | C (country required + codemod) | E |
| 4-5 | D (buildCitySlug helper) | F |
| 5 | E (NOT NULL en DB) | — |
| 6-9 | F (city seed completo, 70k filas) | — |
| 10-12 | G + H (tests + lint) | I, J |
| 13 | I + J (docs + cleanup) | — |

**Total: ~13 días de trabajo efectivo.**

## Riesgo / rollback por sprint

| Sprint | Riesgo | Mitigación |
|---|---|---|
| A | Carga DB durante backfill | Correr en off-peak; chunk pequeño |
| C | 160 archivos cambian → posibles regresiones | Codemod idempotente + dry-run; tests existentes |
| D | Cambio de firma en muchos sites | Codemod automático |
| E | Si quedan NULLs, ALTER NOT NULL falla | Verificar Sprint A primero |
| F | 70k INSERT rows | ON CONFLICT DO NOTHING, ejecutar en off-peak |
| G/H | False positives bloqueando CI | Allowlist por source si necesario |

## Métricas de éxito

| Métrica | Antes | Objetivo |
|---|---|---|
| `professionals.city_country NULL` count | 0 (hoy) | 0 (sostenido) |
| Top-1 city share (CA ingeniería) | 49% | <25% |
| Top-1 city share (ES dentista) | 96% → NULL+province | <30% real |
| Cross-country contaminated rows | 0 (hoy) | 0 (sostenido) |
| Sources sin `country` field | 35 archivos | 0 |
| Scrapers añadidos sin tocar `SOURCE_COUNTRY` | n/a | ∞ (mapa eliminado) |

## Salida final

- Schema robusto: `city_country NOT NULL` + composite FK garantizan invariantes 1 y 2.
- Type system robusto: `country: ...` required en `ScrapedProfessional` garantiza invariante 3.
- Tests + lint detectan regresiones.
- Sin mapas estáticos manuales.
- Una sola convención para `citySlug` y province granularity.
