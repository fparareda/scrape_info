# Coverage audit — Phase 0 results

**Scope:** ES, FR, MX, US, CA × 20 categorías. Datos extraídos vía MCP `supabase-prolio` sobre `professionals` (1,143,458 filas) y `cities` (1,610 filas). Las agregaciones corren server-side; el cliente sólo recibe los resúmenes.

## Resumen ejecutivo

Antes de pensar en la Fase 0 (re-geocoding) la auditoría destapa un problema **más urgente y profundo**: hay contaminación entre países por colisión de `cities.slug`. Filas que pertenecen a México están registradas como España (slug `guadalajara`), filas de Francia están como Canadá (slug `laval`), etc. Esto debe arreglarse PRIMERO porque cualquier re-geocoding posterior se basa en el país.

**4 tipos de hueco** (el plan original solo contemplaba 3):

| Tipo | Definición | Celdas | Pros afectados |
|---|---|---:|---:|
| **A-BIS** *(nuevo)* | Cross-country slug collision. Filas en el país equivocado. | 12 | ~5,500 |
| **A** | Concentración patológica intra-país. Registry HQ fallback / provincial collapse. | 18 | ~358,000 |
| **B** | Categoría vacía (≤ 20 pros) en el país. | 17 | ~50 |
| **C** | Categoría real pero <30 ciudades distintas. | 11 | ~37,000 |
| OK | Cobertura razonable (incluye categorías con concentración demográfica natural en capitales). | 42 | ~743,000 |

---

## Tipo A-BIS — Contaminación entre países (urgente, va antes de Fase 0)

**Causa raíz:** el resolver de ciudad busca `cities.slug` sin filtrar por país de la fuente. Los slugs colisionan:

| Slug compartido | Países | Síntoma |
|---|---|---|
| `guadalajara` | ES (Castilla-La Mancha), MX (Jalisco) | TODA fuente MX cae en `guadalajara` de España |
| `laval` | FR (Mayenne), CA (Québec) | TODA fuente FR pequeña cae en `laval` de Canadá |
| `richmond` | CA (BC), US (VA) | TSBC (BC) cae en Richmond, US (84 HVAC, 149 electricidad) |
| `paris` | FR, US (TX) | Texas TDLR cae en Paris, FR |
| `el-paso` / `laredo` / `santa-barbara` / `aurora` | US ↔ MX/ES | Fuentes ES/MX caen en US |
| `salvatierra` / `lerma` | ES, MX | Fuentes ES caen en MX |

Listado completo en [`contamination-cross-country.csv`](contamination-cross-country.csv).

**Acción requerida (Sprint 0, NUEVO):**

1. Auditar duplicados: `SELECT slug, array_agg(country) FROM cities GROUP BY slug HAVING COUNT(DISTINCT country) > 1`.
2. En `src/sink.ts`, el resolver de ciudad debe filtrar por país de la fuente: cada source declara `country_iso` y se hace `WHERE slug = $1 AND country = $2`.
3. Re-asignar las ~5,500 filas contaminadas: ya sabemos su fuente → sabemos su país real → resolver con el nuevo filtro.
4. Considerar migrar la PK de `cities` a compuesta `(country, slug)` o renombrar duplicados a `<slug>-<country>` para que sea imposible volver a colisionar.

---

## Tipo A — Concentración patológica (Fase 0 original)

Celdas con >40% en top-1 ciudad **dentro del país correcto**, o <5 ciudades distintas con >50 filas. Origen: el scraper inserta la dirección del colegio/registro como fallback porque la fuente no expone el domicilio profesional.

| País | Categoría | Total | Top-1 ciudad | Share | Source primario | Sub-clase |
|---|---|---:|---|---:|---|---|
| ES | dentista | 42,044 | Vitoria-Gasteiz | 96.0% | guiadentistas-es | A.1 |
| CA | ingenieria | 71,516 | Calgary | 81.8% | apega | A.2 |
| ES | medicina | 76,269 | Madrid | 55.7% | com_madrid (40k 100% Madrid) | A.1 mixto |
| CA | hvac | 28,419 | Saskatoon | 85.3% | tsask | A.2 |
| CA | electricidad | 26,009 | Saskatoon | 65.8% | tsask | A.2 |
| CA | medicina | 14,051 | Halifax | 70.4% | cpsns-ns-physicians + cpsnl + cpspei | A.1 |
| MX | fiscal | 43,603 | CDMX | 65.6% | sat-efos-edos + cnsf-agentes | A.1 |
| MX | fontaneria | 4,457 | CDMX | 74.2% | cre-permisionarios | A.1 |
| MX | hvac | 403 | CDMX | 83.6% | cre-permisionarios | A.1 |
| CA | mecanica | 7,026 | Calgary | 46.0% | amvic-dealers | A.2 |
| CA | arquitecto | 1,491 | Montréal | 66.7% | oaq | A.2 |
| CA | fisioterapia | 282 | Winnipeg | 92.9% | cpm-physio | A.1 |
| CA | veterinario | 1,818 | Saskatoon | 100% | svma-sk-vets | A.1 |
| CA | dentista | 1,019 | Toronto | 41.4% | rcdso | A.2 |
| FR | abogado | 45,446 | Paris | 45.2% | cnb-avocats | A.3 (real) |
| FR | arquitecto | 22,003 | Paris | 42.5% | architectes-fr (57% Paris) + sirene-insee | A.3 (real) |
| FR | cerrajero | 5,170 | Paris | 46.3% | sirene-insee | A.3 (real) |
| FR | electricidad | 10,392 | Paris | 46.0% | sirene-insee | A.3 (real) |

**Sub-clases dentro de Tipo A** y cómo se arregla cada una:

- **A.1 Registry HQ fallback** — el registro publica una dirección común (sede colegial / fiscal). Fix = `city_slug = NULL` + `metadata.province_slug` + `metadata.location_granularity = 'province'`. El frontend los mostrará en buscadores regionales, no en `ciudad × oficio`. **Ejemplos**: ES dentista (Vitoria), MX fiscal (sat-efos-edos), CA veterinario (Saskatoon), CA medicina (Halifax).
- **A.2 Provincial collapse** — el registro es provincial y todos los pros realmente trabajan en esa provincia, pero el scraper geocodifica a la capital. Fix = re-geocode desde la dirección real disponible en `metadata.<algún campo>`. **Ejemplos**: APEGA (todo Alberta → Calgary), TSASK (todo Saskatchewan → Saskatoon).
- **A.3 Capital bias real (no es bug)** — la fuente sí tiene dirección y los pros realmente están concentrados en la capital. **No requiere fix**. **Ejemplos**: FR abogado/arquitecto/cerrajero en Paris (45% Paris es realista — la mitad de los avocats franceses están en Île-de-France).

---

## Tipo B — Categorías vacías (necesitan scraper nuevo)

| País | Categorías vacías o casi vacías (≤20) |
|---|---|
| ES | abogado, cerrajero, enfermeria, farmacia |
| MX | abogado, enfermeria, farmacia, cerrajero (8), itv (10) |
| US | abogado, arquitecto, cerrajero, fisioterapia, ingenieria |
| CA | enfermeria, notario |
| FR | notario |

17 celdas. Cada una requiere un scraper nuevo o adaptar uno existente. Mapeado a sources gratuitas en el plan original (Sprints 3-7).

---

## Tipo C — Cobertura parcial geográfica

Categorías reales pero <30 ciudades distintas:

| País | Categoría | Total | n_cities | Causa probable |
|---|---|---:|---:|---|
| CA | extranjeria | 4,719 | 20 | sólo NB+SK+ON bar associations |
| CA | fiscal | 1,891 | 21 | sólo google_places disperso |
| CA | fontaneria | 1,267 | 21 | sólo google_places |
| CA | psicologia | 3,847 | 21 | cap-psychologists 70% Calgary |
| ES | veterinario | 14,307 | 27 | vucolvet sólo en 26 ciudades |
| MX | dentista | 4,404 | 31 | denue-mx 7 ciudades + siem 26 |
| MX | fisioterapia | 403 | 17 | denue-mx 7 ciudades |
| MX | psicologia | 754 | 15 | denue-mx 7 ciudades |
| US | carpinteria | 2,594 | 17 | google_places 16 metros + yelp 2 |
| US | fiscal | 2,492 | 16 | idem |
| US | extranjeria | 2,106 | 16 | idem |
| US | fontaneria | 1,743 | 17 | idem |

Fix: añadir sources oficiales que falten (provincial colleges CA, state boards US, SEP-RNP MX) + backfill Overture/OSM (gratis).

---

## Source breakdown — top 10 sources más problemáticas

| Source | País asignado | Categoría | Filas | Top-1 | Diagnóstico |
|---|---|---|---:|---:|---|
| apega | CA | ingenieria | 71,516 | 81.8% Calgary | A.2 (re-geocode desde dirección) |
| guiadentistas-es | ES | dentista | 41,996 | 96.1% Vitoria | A.1 (NULL city + province) |
| com_madrid | ES | medicina | 40,034 | 100% Madrid | A.1 (scope colegial=Madrid, OK conceptualmente) |
| tsask | CA | hvac | 24,569 | 98.7% Saskatoon | A.2 |
| tsask | CA | electricidad | 17,437 | 97.8% Saskatoon | A.2 |
| sat-efos-edos | MX | fiscal | 14,055 | 100% CDMX | A.1 (lista federal con domicilio fiscal CDMX) |
| cnsf-agentes | MX | fiscal | 10,000 | 100% CDMX | A.1 |
| cpsns-ns-physicians | CA | medicina | 6,728 | 100% Halifax | A.1 (NS-wide collapsed) |
| cre-permisionarios | MX | fontaneria | 3,305 | 100% CDMX | A.1 |
| cpsnl | CA | medicina | 2,227 | 100% Halifax | A.1 (NL collapsed) |

Datos completos: [`source-breakdown.csv`](source-breakdown.csv) y [`per-country-category.csv`](per-country-category.csv).

---

## Plan revisado — orden de ejecución

**Sprint 0 (NUEVO, urgente)** — Fix Tipo A-BIS.
- Audit SQL de slugs duplicados.
- Reescribir resolver de ciudad en `src/sink.ts` con filtro por país.
- Re-asignar las ~5,500 filas contaminadas.
- Migrar PK a `(country, slug)` o renombrar slugs duplicados.
- **Coste**: 1-2 días.
- **Impacto**: limpia ~5.5k filas y previene re-contaminación futura.

**Sprint 1** — Fase 0 original (re-geocoding) sobre sources clasificadas A.1/A.2.
- Sample dirigido de `metadata` para top-10 sources problemáticas.
- A.1 → NULL city + province_slug en metadata.
- A.2 → re-geocode desde dirección real.
- **Impacto**: reubica correctamente ~140k pros.

**Sprints 2-9** — Plan original (Tipo B + Tipo C + Overture/OSM backfill gratuito).

---

## Archivos generados

- [`summary.md`](summary.md) — este documento
- [`per-country-category.csv`](per-country-category.csv) — clasificación de cada celda
- [`contamination-cross-country.csv`](contamination-cross-country.csv) — filas mal asignadas de país
- [`source-breakdown.csv`](source-breakdown.csv) — ver siguiente paso

## Pendiente

- [ ] Volcar `source-breakdown.csv` completo (datos ya disponibles, falta dump).
- [ ] `metadata-fields-by-source.json` — sample de `metadata` por source. Se hará al inicio de Sprint 1 con queries dirigidas a las 10 sources críticas.
