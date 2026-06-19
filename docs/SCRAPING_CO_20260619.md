# Plan de scraping — Colombia (CO)

> Fecha: 2026-06-19 · Autor: plan generado para Ferran
> Estado: **propuesta** (aún no implementado).
> - El **tipo** no soporta CO: `CountryCode` = `"ES" | "CA" | "US" | "FR" | "MX" | "GB"`
>   ([cities.ts:1](../src/cities.ts)); no hay ninguna fuente `*-co` ni helper `co()` en
>   [cities.ts](../src/cities.ts) (la lista estática = ciudades "marcadas" que ve la web).
> - Pero la **DB ya tiene el gazetteer**: 1.119 municipios CO en `public.cities` (gazetteer
>   DANE completo, `region` = departamento). **0 empresas** CO en `professionals` (de 4,27M totales).
>
> **✅ Fase 0 hecha (2026-06-19, rama `feat/co-phase-0`):**
> - `"CO"` añadido a todas las uniones de país (types.ts ×2, sink.ts `resolveCountry`,
>   city-upsert.ts `CityCountry`, cities.ts `CountryCode`) + soporte CO en google-places y yelp.
> - cities.ts: helper `co()` + `COLOMBIAN_CITIES` (top-30 marcadas) + `staticByCountry` +
>   `deriveQueryLocale` + se quitó CO del whitelist-drop de `loadFromDb`. `npm run typecheck` ✅.
> - DB: top-30 geocodificadas (30/1.119); cola larga (1.089) sigue NULL → almacenable,
>   promocionable luego. **Pendiente**: backfill geocoding de las 1.089 (Nominatim) + primer scraper.

---

## 0. Contexto y recomendación

- **Shift de política (2026-06-19): ninguna fuente bulk vuelve a perder filas por ciudad
  no sembrada.** Toda fuente que pueda descargar empresas en masa (sin búsqueda por
  población) ingiere el dataset **entero** y **auto-siembra** el municipio que falte (con
  geocoding), en vez de descartarlo. Ver §1.
- **Recomendación: 8 scrapers nuevos** repartidos en 3 fases, + habilitar Colombia en
  las 4 fuentes multipaís que ya tenemos (Google Places, OSM, GLEIF, Wikidata) sin
  escribir código de scraper nuevo, solo sembrando ciudades y targets.
- La gran palanca: **`datos.gov.co` es un portal Socrata**. Eso significa que reutilizamos
  [`_socrata-utils.ts`](../src/sources/_socrata-utils.ts) tal cual (`host: "www.datos.gov.co"`,
  `viewId: "<id>"`), igual que ya hacemos con CT, Chicago, Montgomery, Delaware. No hay
  que construir paginación ni parseo nuevo.
- El modelo correcto para "directorio de empresas de un país" ya existe en el repo: es
  **DENUE-MX** ([denue-mx.ts](../src/sources/denue-mx.ts), [denue-mx-trades.ts](../src/sources/denue-mx-trades.ts)),
  un censo nacional de negocios filtrado por código de actividad a nuestras categorías.
  El análogo colombiano es el **RUES / registro mercantil filtrado por CIIU**.
- ⚠️ **Aviso estratégico**: [targets.ts](../src/targets.ts) documenta la decisión del CEO
  (22-abr-2026) de centrar Prolio en el *wedge* Madrid/Barcelona (extranjería + fiscal +
  trades). Colombia es una expansión nueva: este plan asume que esa decisión ya está tomada.

---

## 1. El shift: ingesta bulk sin pérdida (ya casi construido)

**Hoy** el sink descarta toda fila cuyo `(country, city_slug)` no esté sembrado en `cities`
([sink.ts:132-141](../src/sink.ts)): solo sobreviven las de ciudad sembrada o `citySlug=""`
(→ `city_slug=NULL`). En un dump nacional de 1M con solo 300k ciudades sembradas, se
perderían 700k. **Eso es lo que cambiamos.**

**La buena noticia: el mecanismo ya existe.** [`src/lib/city-upsert.ts`](../src/lib/city-upsert.ts)
(`ensureCity()` + `getCityUpsertStats()`) hace exactamente esto, y ya está en producción en
[data-gov-ct-elicense.ts:187](../src/sources/data-gov-ct-elicense.ts). Su cabecera describe
literalmente este problema ("*loses 30-90% of rows in US datasets*"). `ensureCity()`:

1. Deriva slug estable (`slugify(nombre) + "-" + estado`) — evita colisiones entre municipios homónimos.
2. Cachea en proceso (no re-geocodifica el mismo municipio).
3. Geocodifica vía **OSM Nominatim** (1 req/s) — **o usa `lat`/`lng` de la fila si el dataset los trae**.
4. `INSERT ... ON CONFLICT DO NOTHING` (seguro entre workers concurrentes).
5. Fallo de geocoding = **no fatal** → inserta con lat/lng NULL + log; backfill offline después.

**Decisiones tomadas (2026-06-19):**
- **Auto-sembrar el municipio (completo)** → cada empresa conserva su ciudad real, no `NULL`.
- **Opt-in por fuente** → solo las fuentes bulk llaman a `ensureCity`; las de búsqueda por
  ciudad (Google Places) mantienen el drop estricto del sink (allí un drop sí señala un bug
  de target sin sembrar, no una pérdida legítima).

**Patrón a seguir en cada scraper bulk** (idéntico a CT eLicense): por cada fila, resolver el
municipio con `ensureCity(client, { name, state: departamento, country: "CO", lat?, lng? })`
y usar el `slug` que devuelve como `citySlug`. Cero filas perdidas.

> ⚠️ **Gap que hay que cerrar primero**: `CityCountry` en
> [city-upsert.ts:29](../src/lib/city-upsert.ts) es `"ES" | "CA" | "US" | "FR" | "MX"` — **no
> incluye `"CO"`**. Hasta añadirlo, `ensureCity` no acepta filas colombianas. Es un cambio de
> una línea, pero es bloqueante.
>
> ℹ️ Nota: `getSink({ trustCitySlugs })` recibe la opción pero **hoy la ignora** (`_opts` en
> [sink.ts:25](../src/sink.ts)) — la auto-siembra la hace la *fuente*, no el sink. Decisión
> de diseño abierta: dejarlo así (patrón CT, probado) o cablear `trustCitySlugs` dentro del
> sink para centralizarlo. Recomendado: dejarlo en la fuente por ahora.

### 1b. Almacenar ≠ mostrar — la whitelist de ciudades

**Crítico**: la auto-siembra resuelve el *almacenamiento*, NO la *visibilidad*. Hay dos capas:

| Capa | Qué es | Dónde vive |
|------|--------|-----------|
| **Almacenamiento** | tabla `cities` (DB) + FK de `professionals` | DB; superset enorme (ES=7.940, US=6.066, CO=1.119 filas) |
| **Visualización** | lista curada de ciudades "marcadas" que renderiza la web | **code-side**: lista estática [cities.ts](../src/cities.ts) (`es()/us()/…`), replicada en el repo web |

`public.cities` **no tiene flag de publicación** (columnas: `slug,name,country,lat,lng,region`).
Por eso una ciudad auto-sembrada queda **almacenada pero oculta**: guarda empresas (FK ok)
pero no aparece en la web hasta que se "marque" añadiéndola a la lista curada.

**Estado CO**: 1.119 municipios en DB, **0 marcados** → aunque ingiramos 1M de empresas, la web
no muestra nada hasta curar ciudades CO. Es la cola larga de ES/CA/MX (miles de filas en DB,
solo cientos mostradas) aplicada a Colombia.

**Estrategia de whitelist (decidida 2026-06-19, detalle en §6.2):** almacenar TODO (las
1.119) y **marcar solo ~30 municipios grandes** ahora; promocionar el resto automáticamente
cuando un municipio supere **≥50 empresas** almacenadas. Lo barato es guardar; lo
caro/SEO-sensible es publicar páginas de ciudad casi vacías.

---

## 2. Qué datos de empresa guardamos hoy en la DB

Todas las fuentes escriben a la tabla **`professionals`** (proyecto Supabase prolio
`wdniquikktnupzjnqyzw`), vía [sink.ts](../src/sink.ts). Upsert por `(source, source_id)`.
Columnas que rellenamos por fila:

| Columna DB        | Origen (`ScrapedProfessional`) | Notas |
|-------------------|-------------------------------|-------|
| `name`            | `name`                        | razón social / nombre comercial |
| `category_key`    | `categoryKey`                 | **una de las 20 categorías-vertical** (ver §4) |
| `city_country`    | `country` / `cityCountry`     | aquí entra **`"CO"`** (hay que añadirlo al union) |
| `city_slug`       | `citySlug`                    | slug de ciudad sembrada, o `NULL` (granularidad departamento) |
| `email`           | `email`                       | |
| `phone`           | `phone`                       | |
| `website`         | `website`                     | |
| `address`         | `address`                     | |
| `lat` / `lng`     | `lat` / `lng`                 | |
| `license_number`  | `licenseNumber`               | matrícula profesional / nº de habilitación |
| `rating` / `review_count` | `rating` / `reviewCount` | solo fuentes tipo Places/Yelp |
| `photo_url`, `opening_hours`, `headline`, `description` | idem | |
| `metadata` (JSONB)| `metadata`                    | **aquí caen NIT, forma jurídica, CIIU, departamento** |

**Importante**: `cif` (= NIT en CO), `legalForm` y `foundedAt` existen en el *tipo*
([types.ts:457](../src/types.ts)) pero **el sink NO los escribe como columnas propias** →
hoy van dentro de `metadata`. Para Colombia, el **NIT** es el identificador de empresa más
valioso; recomendación: guardarlo en `metadata.nit` (y opcionalmente `metadata.ciiu`,
`metadata.departamento`, `metadata.legal_form`) hasta decidir si merece columna propia.

---

## 3. Inventario de directorios de empresa de Colombia

Ordenado por valor / facilidad. IDs de dataset Socrata verificados en búsqueda; el esquema
exacto de columnas hay que confirmarlo al implementar cada uno.

### Tier A — `datos.gov.co` (Socrata, esfuerzo bajo, reutiliza `_socrata-utils`)

Esquemas **verificados en vivo** (2026-06-19, `?$limit=3` + metadata del view). Socrata
serializa tildes/ñ en los fieldName como `_` (`t_lefonosede`, `direcci_nsede`,
`n_mero_doc_…`) y los nulos de SECOP llegan como string `"No Provisto"`.

| # | Fuente | viewId | Filas | ¿Clasificable? (CIIU/clase) | ¿Municipio? | ¿Contacto? | Rol |
|---|--------|--------|-------|------------------------------|-------------|------------|-----|
| A1 | **RUES / Registro Mercantil** | `c82u-588k` | **9.293.659** | ✅ `cod_ciiu_act_econ_pri/_sec` (solo código) | ❌ solo `camara_comercio` (sede cámara) | ❌ ninguno | **Columna vertebral**: clasifica por CIIU + NIT; geo gruesa por cámara |
| A2 | **SECOP II – Proveedores** | `qmzu-gj57` | **1.576.446** | ❌ sin CIIU (UNSPSC "No Definido") | ✅ `municipio`,`departamento`,`ubicacion`(cód. DANE) | ✅ `telefono`,`correo`,`direccion`,`sitio_web` | **Enriquecimiento por NIT** (no clasifica solo) |
| A3 | **REPS – Prestadores y Sedes** | `c36g-9fc2` | **76.821** | ✅ `claseprestador` → salud | ✅ `municipioprestadordesc`+cód. DANE | ✅ `telefonoprestador`,`email_prestador`,`direccionprestador` | **Standalone salud** (medicina/dentista/…) — mejor 1er scraper |
| A4 | RETHUS – Talento Humano Salud | `my8c-6xkk` | millones | parcial (profesión) | por confirmar | nº registro | profesionales sanitarios individuales |
| A5 | *(opc.)* Superfinanciera vigiladas | `sr9n-792w` | bajo | fiscal/financiero | — | — | nicho |
| A6 | *(opc., enrich)* Supersociedades EEFF | `pfdp-zks5` | decenas de miles | CIIU | sí | — | enrich NIT/actividad |

> ⚠️ **Restricción decisiva del modelo (verificada en DB):** `professionals.category_key`
> es **NOT NULL** y FK a las 20 verticales. **Una empresa que no se pueda clasificar en una
> vertical NO se puede almacenar.** Esto acota "guardar todas las empresas":
> - **RUES** → como [denue-mx-trades](../src/sources/denue-mx-trades.ts): mapear CIIU→vertical
>   y **quedarnos solo con el subconjunto que cae en nuestras 20 categorías** (la mayoría de
>   los 9,3M — comercio, agro… — no mapea y se descarta en clasificación, no por ciudad).
> - **SECOP** no tiene CIIU → **no clasifica solo**. Su valor es **join por NIT** sobre las
>   empresas ya clasificadas por RUES, para añadir `municipio`+contacto. No es directorio standalone.
> - **REPS** clasifica por `claseprestador` → verticales de salud, con municipio+contacto → standalone.
>
> Geo de RUES: sin municipio; lo más fino es `camara_comercio` (ciudad sede de la cámara) →
> mapear a slug (muchas sedes están en el top-30; el resto las auto-siembra `ensureCity`).

### Tier B — Consejos profesionales (HTML/Playwright, patrón "colegios ES/MX")

| # | Fuente | Qué contiene | Categoría | Acceso |
|---|--------|--------------|-----------|--------|
| B1 | **COPNIA** (copnia.gov.co) | Registro nacional de ingenieros | ingenieria | consulta pública web |
| B2 | **CPNAA** (cpnaa.gov.co) | Registro de arquitectos y auxiliares | arquitecto | consulta pública web |
| B3 | **JCC** (Junta Central de Contadores) | Contadores públicos | fiscal | consulta pública web |
| B4 | *(opcional)* **SIRNA / Rama Judicial** | Registro Nacional de Abogados | abogado | consulta pública web |

> Estos registros suelen ser consulta-por-documento (sin listado masivo). Igual que con
> algunos colegios ES, puede que solo sirvan para **enriquecer/verificar** matrícula, no
> para bootstrap masivo. Confirmar al implementar si exponen listado o API.

### Tier C — Multipaís ya existentes: solo habilitar CO (sin scraper nuevo)

No requieren archivo nuevo, solo sembrar ciudades CO + targets:

- **Google Places** ([google-places.ts](../src/sources/google-places.ts)) — bootstrap de
  cerrajero, mecánica, fontanería, carpintería, hvac, electricidad (donde no hay registro limpio).
- **OSM** ([osm.ts](../src/sources/osm.ts)) + **osm-locksmith-worldwide** ([osm-locksmith-worldwide.ts](../src/sources/osm-locksmith-worldwide.ts)).
- **GLEIF** ([gleif.ts](../src/sources/gleif.ts)) — entidades con LEI en CO (NIT + forma jurídica).
- **Wikidata** ([wikidata.ts](../src/sources/wikidata.ts)).

---

## 4. Mapa CIIU → categorías (para A1 RUES / A2 SECOP)

Las 20 categorías son verticales de profesión/oficio
([prolio-types.ts:5](../src/prolio-types.ts)), no "empresa genérica". Por eso RUES se
ingiere **filtrado por CIIU** (igual que DENUE-MX filtra por SCIAN), descartando lo que no
mapee. Mapeo inicial propuesto (revisión 4 de CIIU Rev. 4 A.C.):

| CIIU (prefijo) | Categoría |
|----------------|-----------|
| 4520 | mecanica |
| 4321 | electricidad |
| 4322 | fontaneria / hvac |
| 4330 / 1623 | carpinteria |
| 8010 / 4329 | cerrajero (parcial) |
| 7110 (arquitectura) | arquitecto |
| 7110 (ingeniería) / 7112 | ingenieria |
| 6920 | fiscal (contabilidad) |
| 6910 | abogado |
| 86xx | medicina / dentista / fisioterapia |
| 7500 | veterinario |
| 4773 / 2100 | farmacia |
| 8690 | enfermeria / psicologia |

> El detalle fino se afina con el catálogo CIIU real al implementar A1. Lo que no mapea se descarta.

---

## 5. Propuesta de scrapers, fases y temporalidad

**8 scrapers nuevos + habilitar 4 multipaís.** Cadencia alineada con la frecuencia real de
actualización aguas arriba y con las convenciones del repo (cron semanal/mensual).

### Fase 1 — Cobertura masiva barata (Socrata)  ← empezar aquí
| Scraper | Fuente | Cadencia | Por qué |
|---------|--------|----------|---------|
| `rues-registro-mercantil-co` | A1 | **mensual** (día 1) | base genérica; dump enorme → bulk mensual sobra |
| `secop-proveedores-co` | A2 | **mensual** | actualiza a diario pero 1×/mes basta |
| `reps-prestadores-salud-co` | A3 | **mensual** | habilitaciones cambian poco |

### Fase 2 — Profesionales sanitarios + multipaís
| Scraper | Fuente | Cadencia |
|---------|--------|----------|
| `rethus-salud-co` | A4 | **trimestral** (volumen alto, cambia lento) |
| *(habilitar)* Google Places CO | C | dentro del cron semanal existente |
| *(habilitar)* OSM CO + GLEIF CO + Wikidata CO | C | dentro de sus crons existentes (mensual) |

### Fase 3 — Consejos profesionales + enriquecimiento
| Scraper | Fuente | Cadencia |
|---------|--------|----------|
| `copnia-ingenieros-co` | B1 | **trimestral** |
| `cpnaa-arquitectos-co` | B2 | **trimestral** |
| `jcc-contadores-co` | B3 | **trimestral** |
| *(opcional)* `supersociedades-eeff-co` | A6 | **anual** (corte anual; solo enrich NIT/actividad) |

**Resumen de cadencia**
- Mensual: A1, A2, A3 (datos.gov.co se refresca seguido; bulk mensual cubre).
- Trimestral: A4 + consejos profesionales (cambian lento, volumen alto).
- Anual: A6 (estados financieros, corte anual).
- Multipaís CO: se cuelgan de los crons ya programados, sin cron nuevo.

---

## 6. Cambios de infraestructura necesarios (antes del primer scraper)

1. **Añadir `"CO"` a las uniones de país** (5 sitios):
   - [types.ts:436](../src/types.ts) (`ScrapedProfessional.country`)
   - [types.ts:445](../src/types.ts) (`cityCountry`)
   - [types.ts:475](../src/types.ts) (`ScrapeTarget.country`)
   - [cities.ts:1](../src/cities.ts) (`CountryCode`)
   - **[city-upsert.ts:29](../src/lib/city-upsert.ts) (`CityCountry`) — bloqueante para la
     auto-siembra bulk (§1); sin esto `ensureCity` rechaza filas CO.**
   - (revisar también `resolveCountry` en [sink.ts:9](../src/sink.ts), cuyo tipo de retorno
     enumera los países y no incluye CO ni GB).
2. **Ciudades CO — el gazetteer YA está en la DB** (1.119 municipios, `region`=departamento),
   así que **no hay que sembrarlo**. Lo que falta:
   - a) **Geocodificar** las 1.119 (hoy lat/lng NULL). Opciones: backfill OSM Nominatim
     (~1.119 × 1,1s ≈ 20 min, gratis) o dejar que `ensureCity` use las coords de cada fila
     si el dataset las trae. Sin coords no hay cálculo de distancia/“cerca de mí”.
   - b) **Curar la whitelist de visualización** (§1b): añadir a la lista estática
     [cities.ts](../src/cities.ts) (vía un helper `co()`) el subconjunto que SÍ se muestra en
     web — p.ej. top ~25-30 (Bogotá, Medellín, Cali, Barranquilla, Cartagena, Cúcuta,
     Bucaramanga, Pereira, Santa Marta, Ibagué, Villavicencio, Valledupar, Montería, Pasto,
     Manizales, Neiva, Armenia…). El resto queda almacenado-pero-oculto, promocionable luego.
   - c) **Decisión tomada (2026-06-19): top ~30 ahora + promoción por métrica.** Marcar y
     geocodificar solo las ~30 grandes; almacenar las 1.119; promocionar un municipio a la
     whitelist automáticamente cuando supere un umbral de empresas (propuesto **≥50**).
     Evita thin-content SEO y da valor inmediato.
   - d) **Implicación de diseño de la promoción**: hoy la whitelist es una lista estática en
     código → automatizar la promoción "por métrica" pide o bien generar PRs sobre
     [cities.ts](../src/cities.ts), o bien (más limpio) **añadir un flag `published` a
     `public.cities`** que la web lea, y un job periódico que lo active cuando
     `count(professionals) ≥ 50` por `(country, city_slug)`. El flag necesita cambio en el
     repo web (leerlo); decisión a coordinar con prolio. Para top-30 inicial no hace falta:
     basta añadirlas al helper `co()` estático.
3. **Wiring de cada fuente en 4 sitios** (riesgo conocido — ver memoria *orphaned-source-wiring*;
   si falta alguno, el scraper "tiene éxito" con 0 filas en silencio):
   - registrar el source en la lista `SOURCES` de [index.ts](../src/index.ts)
   - añadirlo al guard de "no sources enabled" de [index.ts](../src/index.ts)
   - crear `src/run-<source>.ts` (runner)
   - crear `.github/workflows/scrape-<source>.yml` (cron)

---

## 7. Riesgos legales / cumplimiento

- **Habeas Data — Ley 1581/2012** es el análogo colombiano del RGPD. RUES (personas
  naturales comerciantes) y RETHUS (profesionales individuales) contienen **datos personales**.
- Aplicar la misma regla que el resto del repo (README): toda fila precargada lleva
  **token de opt-out desde el día 1**.
- RUES vía `datos.gov.co` es dato abierto oficial (uso permitido); evitar el portal
  `rues.org.co` directo (extractos certificados de pago, sin API libre).
- Confecámaras **no publica API abierta**; no depender de terceros de pago (Apitude, etc.).

---

## 8. Verificación recomendada antes de codificar

1. Confirmar esquema/columnas reales de A1–A4 (nombres snake_case, presencia de NIT y CIIU)
   con `https://www.datos.gov.co/resource/<viewId>.json?$limit=5`.
2. Confirmar volumen con `?$select=count(*)` para decidir paginación JSON vs bulk CSV
   (el cap JSON Socrata es 50k/página; >500k → preferir CSV bulk, ver [_socrata-utils.ts](../src/sources/_socrata-utils.ts)).
3. Validar el mapa CIIU contra el catálogo oficial CIIU Rev. 4 A.C.

---

## 9. Estado de implementación (2026-06-19, rama `feat/co-phase-0`)

### Hecho (código, `npm run typecheck` ✅)
- **Fase 0** — `"CO"` en todas las uniones de país (types ×3, sink `resolveCountry`,
  `CityCountry`, `CountryCode`) + soporte CO en google-places/yelp; helper `co()` +
  `COLOMBIAN_CITIES` (top-30) + `staticByCountry`/`deriveQueryLocale`/`loadFromDb` whitelist.
- **B (bulk no-filtra)** — `getSink({ trustCitySlugs: true })` ahora omite el drop por ciudad;
  contrato: la fuente bulk llama a `ensureCity` por fila. [sink.ts](../src/sink.ts).
- **A1 (whitelist tabla)** — migración `20260619000001_city_whitelist.sql` (tabla + seed 30 CO).
- **Categoría genérica** — `"empresa"` añadida a `CategoryKey` + entradas no-op en los 6 mapas
  vertical-específicos (synonyms, borme/filter, osm, paginas-amarillas, competitor-es-mega ×3);
  migración `20260619000002_category_empresa.sql`.

- **D2 (3 scrapers CO)** — `reps-salud-co`, `rues-registro-mercantil-co`,
  `secop-proveedores-co` (Socrata + `ensureCity` por fila + `getSink({trustCitySlugs:true})`).
  Wiring en **5 sitios** cada uno: import + `enabled` + guard + tabla dispatch en
  [index.ts](../src/index.ts), env en [_scrape-runner.yml](../.github/workflows/_scrape-runner.yml),
  workflow `scrape-*.yml`, y **el enum `source_kind`** (5º sitio, antes desconocido).
- **A4** — `promote_cities(min_count)` SQL fn + [run-promote-cities.ts](../src/run-promote-cities.ts)
  + workflow `promote-cities.yml` (lunes, umbral 50).

### Hecho (datos prod)
- Top-30 ciudades CO geocodificadas (30/1.119).
- Migraciones aplicadas: `city_whitelist` (+seed 30), `category_empresa`, `source_kind` (+3 slugs),
  `promote_cities` fn.
- **Smoke test REPS (150 filas) → 150 escritas**; 71 en municipios fuera del top-30 →
  almacenadas pero ocultas (prueba de no-pérdida + whitelist).

### Pendiente / requiere coordinación o ejecución
- **A3 (repo web prolio)** — la web debe leer `city_whitelist` (en vez de su lista estática) y
  renderizar la categoría `empresa`. Hasta entonces la ingesta CO queda almacenada pero invisible.
- **Ejecutar las cargas completas** — disparar los workflows (o `workflow_dispatch`): REPS 77k,
  SECOP 1,58M, RUES 9,3M. Hoy solo corrió el smoke de 150 de REPS.
- **Backfill geocoding cola larga** (1.089 NULL) — opcional; `ensureCity` las geocodifica al ingerir.
- **Enriquecimiento SECOP⨝RUES por NIT** — subir categoría de `empresa`→vertical donde RUES sepa el CIIU.
