# Sprint 0 — Cross-country resolver fix

## Diagnóstico (verificado)

`cities.slug` no tiene duplicados entre países (verified). El bug es que **faltan ciudades en `cities`** para los países "secundarios". Casos confirmados:

| Slug existente | País presente | País(es) faltante(s) | Filas contaminadas |
|---|---|---|---|
| `guadalajara` | ES | MX (Jalisco) | ~3,500 |
| `laval` | CA | FR (Mayenne) | ~150 |
| `richmond` | US | CA (BC) | ~240 |
| `paris` | FR | US (TX) | 3 |
| `el-paso` | US | ES (Cáceres) | 4 |
| `laredo` | US | ES (Cantabria) | ~18 |
| `santa-barbara` | US | ES (provincia de Lugo) | 7 |
| `aurora` | US | CA (ON) | 32 |
| `salvatierra` | MX | ES (Álava) | 9 |
| `lerma` | MX | ES (Burgos) | 1 |
| `stephenville` | CA | US (TX) | 3 |

Las filas se insertan con `city_slug = slugify(name)` y el FK acepta el slug existente del país equivocado. Total ~5,500 filas afectadas.

## Patch del sink — diseño

### Opción A (mínima, recomendada): composite (country, slug) en `cities`

1. **Migración SQL**:
   ```sql
   ALTER TABLE cities DROP CONSTRAINT cities_pkey;
   ALTER TABLE cities ADD PRIMARY KEY (country, slug);
   -- professionals.city_slug → professionals.(city_country, city_slug)
   ALTER TABLE professionals ADD COLUMN city_country char(2);
   UPDATE professionals SET city_country = (SELECT country FROM cities c WHERE c.slug = professionals.city_slug LIMIT 1);
   ALTER TABLE professionals DROP CONSTRAINT professionals_city_slug_fkey;
   ALTER TABLE professionals ADD CONSTRAINT professionals_city_fkey
     FOREIGN KEY (city_country, city_slug) REFERENCES cities(country, slug);
   ```

2. **Cambios en `src/sink.ts`**:
   - `loadCitySlugs()` → `loadCityKeys()` retorna `Set<string>` con `"${country}::${slug}"`.
   - `validate(records)` filtra por `validKeys.has(`${r.country}::${r.citySlug}`)`.
   - `ScrapedProfessional` añade `country: 'ES'|'FR'|'MX'|'US'|'CA'` (ya hay metadata.country en muchas sources; promoverlo a campo first-class).

3. **Backfill de las 5,500 filas contaminadas**:
   ```sql
   -- Re-asignar usando el país declarado por la fuente
   WITH src_country AS (
     SELECT 'apega' AS source, 'CA' AS country UNION ALL
     SELECT 'denue-mx', 'MX' UNION ALL
     SELECT 'siem', 'MX' UNION ALL
     SELECT 'cofepris-farmacias', 'MX' UNION ALL
     SELECT 'cnb-avocats', 'FR' UNION ALL
     SELECT 'rpps-fr', 'FR' UNION ALL
     SELECT 'annuaire-sante-ans', 'FR' UNION ALL
     SELECT 'sirene-insee', 'FR' UNION ALL
     SELECT 'ademe-rge', 'FR' UNION ALL
     -- … completar con los ~30 sources implicados
   )
   UPDATE professionals p
   SET city_country = sc.country,
       city_slug = NULL  -- forzar re-geocode en Sprint 1
   FROM src_country sc
   WHERE p.source = sc.source
     AND (SELECT country FROM cities WHERE slug = p.city_slug) <> sc.country;
   ```

4. **Seed de ciudades faltantes**: necesitamos al menos las 11 ciudades del cuadro de arriba en su país correcto. Después del filtro por país, Sprint 1 las re-resolverá usando dato real.

### Opción B (más invasiva): slug con sufijo de país

`guadalajara` → `guadalajara-es`. `guadalajara-mx` se crea como ciudad nueva. Necesita rename masivo, no recomiendo.

## Pasos concretos para Sprint 0

1. Crear migración `0020_cities_composite_pk.sql` con la opción A.
2. En `src/types.ts`, añadir `country` a `ScrapedProfessional`.
3. Adaptar `src/sink.ts` (~40 líneas de cambio).
4. Auditar las ~80 sources: cada una declara su país hardcoded en el código del scraper o lo deriva del data. Sólo confirmar que el campo se pasa.
5. Backfill SQL de las 5,500 filas contaminadas (`city_country` desde tabla de mapping source→country).
6. Re-run [`audit-output/contamination-cross-country.csv`](contamination-cross-country.csv) post-fix para confirmar 0 filas mal asignadas.

**Tiempo estimado**: 1 día de trabajo + 1 día de validación.
