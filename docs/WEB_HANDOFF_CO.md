# Hand-off para el repo web (prolio) — leer `city_whitelist`, categoría `empresa`, país CO

> Pega TODO este documento en un contexto de Claude nuevo, abierto en el **repo web (prolio)**.
> La capa de datos ya está hecha (DB compartida, proyecto Supabase prolio `wdniquikktnupzjnqyzw`).
> Tu trabajo es solo capa de presentación. NO toques scraping ni el repo `scrape_info`.

## Contexto: qué cambió en la DB (ya aplicado en prod)

1. **Nueva tabla `public.city_whitelist`** `(country, slug, added_at, reason)`, PK `(country,slug)`,
   FK → `cities(country,slug)`. **Regla nueva: una ciudad se muestra en la web ⟺ existe su fila aquí.**
   Motivo: `public.cities` pasó a ser un **superset de almacenamiento** (los scrapers bulk
   auto-siembran municipios). La whitelist es el subconjunto que SÍ se renderiza.
   **Ya está poblada** (no hay que sembrarla):
   - **ES/US/CA/MX/FR/GB**: todas las ciudades con **≥5 profesionales** (regla acordada; el job
     `promote_cities` la mantiene al día semanalmente).
   - **CO**: **50 ciudades curadas** (las 50 más grandes) — NO sigue la regla de ≥5, es manual.

2. **Nueva categoría `empresa`** en `public.categories` (ya insertada): comodín para empresas que
   no encajan en una vertical de profesión. Valores:
   `key='empresa'`, `slug_es='empresa'`, `slug_en='company'`, `slug_fr='entreprise'`,
   `name_es='Empresa'`, `name_en='Company'`, `name_fr='Entreprise'`,
   `plural_name_es='Empresas'`, `plural_name_en='Companies'`, `plural_name_fr='Entreprises'`.

3. **Nuevo país `CO` (Colombia)** — `cities` tiene ~1.119 municipios CO; `professionals` ya recibe
   filas CO (categorías verticales + `empresa`; fuentes `reps-salud-co`, `secop-proveedores-co`,
   `rues-registro-mercantil-co`). Locale: `es`.

## Tu tarea

### 0. Explora primero
Localiza cómo decide HOY la web (a) qué ciudades renderiza/navega/mete en sitemap (por país), y
(b) qué categorías. Probablemente una lista estática + un enum de categorías.

### 1. Cambiar el gating de ciudades a `city_whitelist`
Sustituye "qué ciudades se muestran" por un join `cities ⋈ city_whitelist` (mostrar ⟺ fila en
whitelist). Aplica a páginas de ciudad, navegación/listados, sitemap y `generateStaticParams`/ISR.
- **Esto es intencionado**: ciudades con <5 profesionales (no whitelisted) dejan de mostrarse —
  es la regla acordada (evita páginas casi vacías). CO solo mostrará sus 50 curadas.
- Despliega detrás de flag/preview. Rollback = revertir solo este cambio (la tabla se queda).

### 2. Añadir la categoría `empresa`
Añádela al tipo/enum de categorías, i18n (usa los slug/name de la fila ya creada), páginas de
categoría, navegación, sitemap y copy SEO. Trátala como una más; ojo al volumen (puede tener
cientos de miles de filas) → paginación/índices.

### 3. Habilitar país `CO`
Añade Colombia a la config de países (locale `es`) para que rendericen sus ciudades whitelisted
y categorías.

### 4. Verificación (gate de seguridad)
Antes de prod, confirma contra la DB que el cambio hace lo esperado:
- **ES/US/CA/MX/FR**: el set mostrado = ciudades con ≥5 profesionales. Compara el conteo
  por país antes/después; lo único que debe desaparecer son ciudades con <5 (intencional).
- **CO**: se ven exactamente las **50** whitelisted, NO las ~1.000 con datos.
- La categoría `empresa` renderiza en una ciudad CO con datos.
- Build/typecheck/lint en verde.

Consultas útiles (DB compartida):
```sql
-- ciudades mostrables por país
select country, count(*) from city_whitelist group by country order by 2 desc;
-- la categoría empresa
select * from categories where key='empresa';
-- ejemplo: pros CO en una ciudad whitelisted
select category_key, count(*) from professionals
where city_country='CO' and city_slug='bogota' group by 1 order by 2 desc;
```

## Importante / qué NO hacer
- **No renderices `public.cities` entero** — es un superset de almacenamiento con miles de
  municipios sin datos. Solo `city_whitelist`.
- **No toques** la lógica de scraping ni `scrape_info`.
- La promoción de ciudades nuevas (cuando superan 5 profesionales) es **automática** del lado
  scraper (job `promote_cities`, excluye CO). Tú solo **lees** `city_whitelist`.
- CO es curada a 50 a propósito: aunque haya ~1.000 municipios CO con datos, solo se muestran 50.

## Estado de los datos CO (a 2026-06-19)
- REPS (salud): completado (~77k).
- SECOP (contratistas, con contacto): cargando, completa en ~días (resume diario).
- RUES (empresas de oficio + NIT): cargando.
- Cruce por NIT activo: filas SECOP con contacto heredan su vertical real de RUES.
- Hay datos suficientes en las ciudades grandes CO para probar ya.
