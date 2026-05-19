-- =============================================================================
-- Sprint 0 + Sprint 1 — bundled SQL for execution in Supabase SQL editor.
--
-- WHY THIS FILE: PostgREST caps every statement at ~8s, which is too short for
-- the bulk UPDATEs on 1.32M rows. Run this in the Supabase SQL editor (which
-- uses the DB role with statement_timeout=0) OR via psql.
--
-- DO NOT run via MCP execute_sql or apply_migration — they hit the same cap.
--
-- ORDER MATTERS. Run sections in order. After each section, check the NOTICEs
-- and decide whether to proceed.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- §0. Pre-flight: confirm starting state.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  total bigint; with_country bigint; without_country bigint;
  has_col boolean;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_name='professionals' AND column_name='city_country'
  ) INTO has_col;
  RAISE NOTICE 'professionals.city_country exists: %', has_col;

  IF has_col THEN
    SELECT COUNT(*),
           COUNT(*) FILTER (WHERE city_country IS NOT NULL),
           COUNT(*) FILTER (WHERE city_country IS NULL)
    INTO total, with_country, without_country FROM professionals;
    RAISE NOTICE 'Pre-flight: total=%, with_country=%, without_country=%',
      total, with_country, without_country;
  END IF;
END$$;


-- -----------------------------------------------------------------------------
-- §1. Sprint 0 phase 1 — Add city_country column (idempotent) and backfill.
--     Should complete in <60s on prod given the city_slug index.
-- -----------------------------------------------------------------------------

ALTER TABLE professionals ADD COLUMN IF NOT EXISTS city_country char(2);

-- One-shot full backfill. UPDATE...FROM uses a hash join on cities (1610 rows)
-- → professionals (1.32M rows). With idx on city_slug, this is ~10-30s.
UPDATE professionals p
SET city_country = c.country
FROM cities c
WHERE c.slug = p.city_slug
  AND p.city_country IS NULL;

DO $$
DECLARE total bigint; with_country bigint;
BEGIN
  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE city_country IS NOT NULL)
  INTO total, with_country FROM professionals;
  RAISE NOTICE '§1 done: %/% rows have city_country', with_country, total;
END$$;


-- -----------------------------------------------------------------------------
-- §2. Sprint 0 phase 2 — Re-key cities on (country, slug) and rebuild the FK.
--
--     The current FKs all reference cities.slug (unique). After this section
--     they reference cities(country, slug). Composite FK uses MATCH SIMPLE
--     (default), so NULL in city_slug is permitted — that's the
--     province-granularity case we want to support in Sprint 1.
-- -----------------------------------------------------------------------------

-- 2.1 — Drop dependent FKs first so we can change the PK on cities.
ALTER TABLE professionals DROP CONSTRAINT IF EXISTS professionals_city_slug_fkey;
ALTER TABLE leads          DROP CONSTRAINT IF EXISTS leads_city_slug_fkey;

-- 2.2 — Switch PK on cities to (country, slug).
ALTER TABLE cities DROP CONSTRAINT IF EXISTS cities_pkey;
ALTER TABLE cities ADD CONSTRAINT cities_pkey PRIMARY KEY (country, slug);

-- 2.3 — Add city_country to leads too (no rows today but the FK needs it).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS city_country char(2);
-- Best-effort populate for any future-seeded rows
UPDATE leads l
SET city_country = c.country
FROM cities c
WHERE c.slug = l.city_slug AND l.city_country IS NULL;

-- 2.4 — Re-add composite FKs. Both NULLABLE; MATCH SIMPLE accepts NULL.
ALTER TABLE professionals
  ADD CONSTRAINT professionals_city_fkey
  FOREIGN KEY (city_country, city_slug) REFERENCES cities(country, slug);
ALTER TABLE leads
  ADD CONSTRAINT leads_city_fkey
  FOREIGN KEY (city_country, city_slug) REFERENCES cities(country, slug);

-- 2.5 — Helpful indexes for the new access pattern.
CREATE INDEX IF NOT EXISTS idx_professionals_country_city
  ON professionals(city_country, city_slug);
CREATE INDEX IF NOT EXISTS idx_professionals_country_category
  ON professionals(city_country, category_key);

DO $$
BEGIN RAISE NOTICE '§2 done: cities re-keyed on (country, slug); composite FK in place'; END$$;


-- -----------------------------------------------------------------------------
-- §3. Sprint 0 phase 3 — Seed missing "secondary-country" cities and fix the
--     ~5,500 mis-attributed rows (the A-BIS bug).
--
--     We don't know the real city for those rows yet (the source put them on
--     the slug of the wrong country). Sprint 1 will re-geocode from metadata.
--     For now: NULL out city_slug and set the correct city_country based on
--     the source's true country.
-- -----------------------------------------------------------------------------

-- 3.1 — Set the correct country for rows from FR sources (currently in CA, etc.).
UPDATE professionals
SET city_country = 'FR', city_slug = NULL
WHERE source IN (
  'cnb-avocats','rpps-fr','annuaire-sante-ans','annuaire-sante-ameli',
  'sirene-insee','ademe-rge','auto-ecoles-fr','prix-controle-technique',
  'cnop-pharmaciens','finess','architectes-fr','oec-fr','ordre-vet-fr',
  'geometres-fr'
) AND city_country IS DISTINCT FROM 'FR';

-- 3.2 — MX sources currently landing on ES via 'guadalajara' etc.
UPDATE professionals
SET city_country = 'MX', city_slug = NULL
WHERE source IN (
  'denue-mx','siem','cofepris-farmacias','condusef-sipres','senasica-mx-vet',
  'padron-notarios-fed-mx','profeco-sancionados','reniecyt-mx','amda-distribuidores',
  'sat-efos-edos','cnsf-agentes','antad-asociados','clues-sinais-mx',
  'cnbv-entidades','cre-permisionarios','dro-cdmx','fcarm-arquitectos',
  'fedmvz-colegios-vet','ift-rpc-mx','imcp-colegios-mx','imss-directorio',
  'notariado-mx','padron-ganadero-nacional','profeco-rpca-talleres',
  'profepa-verificentros-edomex','re-franchises-mx','sat-cpr-mx',
  'sedema-verificentros-cdmx','verificacion-edomex','verificacion-jalisco',
  'colegio-notarios-cdmx','colegios-notarios-mx','conacem-mx','conahcyt-snii',
  'doctoralia-mx','ema-acreditados'
) AND city_country IS DISTINCT FROM 'MX';

-- 3.3 — US sources (texas-tdlr) landing on FR/CA via 'paris', 'stephenville'.
UPDATE professionals
SET city_country = 'US', city_slug = NULL
WHERE source = 'texas-tdlr'
  AND city_country IS DISTINCT FROM 'US';

-- 3.4 — BC (CA) sources landing on US via 'richmond'.
UPDATE professionals
SET city_country = 'CA', city_slug = NULL
WHERE source IN ('tsbc','ecra')
  AND city_country IS DISTINCT FROM 'CA';

-- 3.5 — ES sources landing on US/MX via 'el-paso', 'salvatierra' etc.
UPDATE professionals
SET city_country = 'ES', city_slug = NULL
WHERE source IN ('ccaa_registry','dgt-itv-es','cgn-notariado')
  AND city_country IS DISTINCT FROM 'ES';

DO $$
DECLARE n bigint;
BEGIN
  SELECT COUNT(*) INTO n FROM professionals WHERE city_slug IS NULL;
  RAISE NOTICE '§3 done: % rows now have city_slug=NULL (will be re-geocoded in Sprint 1)', n;
END$$;


-- =============================================================================
-- SPRINT 1 — Re-geocode A.2 / A.2-bis sources from metadata.
--
-- Each block:
--   1. Inserts missing target cities into `cities` (so the FK can hold).
--   2. UPDATEs city_slug from the metadata field, slugified.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- §4. Helper: slugify function. Needs the unaccent extension.
-- -----------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE OR REPLACE FUNCTION public.scrape_slugify(input text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(
           regexp_replace(
             lower(unaccent(coalesce(input, ''))),
             '[^a-z0-9]+', '-', 'g'
           ),
           '(^-+|-+$)', '', 'g'
         );
$$;


-- -----------------------------------------------------------------------------
-- §5. APEGA (CA, 71,516 rows) — metadata.raw_city → city_slug
-- -----------------------------------------------------------------------------

-- 5.1 — Seed any missing CA cities from APEGA raw_city values.
INSERT INTO cities (country, slug, name)
SELECT DISTINCT 'CA', scrape_slugify(metadata->>'raw_city'), metadata->>'raw_city'
FROM professionals
WHERE source = 'apega'
  AND metadata->>'raw_city' IS NOT NULL
  AND scrape_slugify(metadata->>'raw_city') <> ''
ON CONFLICT (country, slug) DO NOTHING;

-- 5.2 — Re-assign city_slug.
UPDATE professionals
SET city_slug = scrape_slugify(metadata->>'raw_city'),
    city_country = 'CA'
WHERE source = 'apega'
  AND metadata->>'raw_city' IS NOT NULL;


-- -----------------------------------------------------------------------------
-- §6. TSASK (CA, 42,488 rows) — same pattern.
-- -----------------------------------------------------------------------------

INSERT INTO cities (country, slug, name)
SELECT DISTINCT 'CA', scrape_slugify(metadata->>'raw_city'), initcap(metadata->>'raw_city')
FROM professionals
WHERE source = 'tsask'
  AND metadata->>'raw_city' IS NOT NULL
  AND scrape_slugify(metadata->>'raw_city') <> ''
ON CONFLICT (country, slug) DO NOTHING;

UPDATE professionals
SET city_slug = scrape_slugify(metadata->>'raw_city'),
    city_country = 'CA'
WHERE source = 'tsask'
  AND metadata->>'raw_city' IS NOT NULL;


-- -----------------------------------------------------------------------------
-- §7. CPSNS-NS-PHYSICIANS (CA, 6,728 rows) — metadata.practice_location
-- -----------------------------------------------------------------------------

INSERT INTO cities (country, slug, name)
SELECT DISTINCT 'CA', scrape_slugify(metadata->>'practice_location'), metadata->>'practice_location'
FROM professionals
WHERE source = 'cpsns-ns-physicians'
  AND metadata->>'practice_location' IS NOT NULL
  AND scrape_slugify(metadata->>'practice_location') <> ''
ON CONFLICT (country, slug) DO NOTHING;

UPDATE professionals
SET city_slug = scrape_slugify(metadata->>'practice_location'),
    city_country = 'CA'
WHERE source = 'cpsns-ns-physicians'
  AND metadata->>'practice_location' IS NOT NULL;


-- -----------------------------------------------------------------------------
-- §8. DATOS-GOB-ES (ES, 11,148 rows) — address last comma-segment is city.
-- -----------------------------------------------------------------------------

-- Extract city by taking the last non-empty segment after the last comma.
-- Sample: "C/ Alicante, s/n, Murcia" → "Murcia"
WITH parsed AS (
  SELECT id, trim(split_part(address, ',', array_length(string_to_array(address, ','), 1))) AS city_name
  FROM professionals
  WHERE source = 'datos-gob-es' AND address IS NOT NULL
)
INSERT INTO cities (country, slug, name)
SELECT DISTINCT 'ES', scrape_slugify(city_name), city_name
FROM parsed
WHERE scrape_slugify(city_name) <> ''
ON CONFLICT (country, slug) DO NOTHING;

UPDATE professionals p
SET city_slug = scrape_slugify(trim(split_part(p.address, ',', array_length(string_to_array(p.address, ','), 1)))),
    city_country = 'ES'
WHERE source = 'datos-gob-es' AND address IS NOT NULL;


-- -----------------------------------------------------------------------------
-- §9. RCDSO (CA, 1,000 rows) — second-to-last comma-segment.
--     Sample: "1140 Burnhamthorpe Rd W #135/136, Mississauga, L5C 0A3"
-- -----------------------------------------------------------------------------

WITH parsed AS (
  SELECT id,
    CASE WHEN array_length(string_to_array(address, ','), 1) >= 2
         THEN trim(split_part(address, ',', array_length(string_to_array(address, ','), 1) - 1))
    END AS city_name
  FROM professionals
  WHERE source = 'rcdso' AND address IS NOT NULL
)
INSERT INTO cities (country, slug, name)
SELECT DISTINCT 'CA', scrape_slugify(city_name), city_name
FROM parsed WHERE city_name IS NOT NULL AND scrape_slugify(city_name) <> ''
ON CONFLICT (country, slug) DO NOTHING;

UPDATE professionals p
SET city_slug = CASE WHEN array_length(string_to_array(p.address, ','), 1) >= 2
                     THEN scrape_slugify(trim(split_part(p.address, ',', array_length(string_to_array(p.address, ','), 1) - 1)))
                END,
    city_country = 'CA'
WHERE source = 'rcdso' AND address IS NOT NULL;


-- -----------------------------------------------------------------------------
-- §10. OAQ (CA, 1,491 rows) — third-to-last comma-segment.
--      Sample: "360, rue St-Jacques, bureau 1500, Montréal, Québec, H2Y 1P5"
-- -----------------------------------------------------------------------------

WITH parsed AS (
  SELECT id,
    CASE WHEN array_length(string_to_array(address, ','), 1) >= 3
         THEN trim(split_part(address, ',', array_length(string_to_array(address, ','), 1) - 2))
    END AS city_name
  FROM professionals
  WHERE source = 'oaq' AND address IS NOT NULL
)
INSERT INTO cities (country, slug, name)
SELECT DISTINCT 'CA', scrape_slugify(city_name), city_name
FROM parsed WHERE city_name IS NOT NULL AND scrape_slugify(city_name) <> ''
ON CONFLICT (country, slug) DO NOTHING;

UPDATE professionals p
SET city_slug = CASE WHEN array_length(string_to_array(p.address, ','), 1) >= 3
                     THEN scrape_slugify(trim(split_part(p.address, ',', array_length(string_to_array(p.address, ','), 1) - 2)))
                END,
    city_country = 'CA'
WHERE source = 'oaq' AND address IS NOT NULL;


-- -----------------------------------------------------------------------------
-- §11. COFEPRIS-FARMACIAS (MX, 15,707 rows; 7,711 have address; rest use
--      metadata.municipio).
--      Sample address: "Av. Azueta No. 173 21100 Mexicali Baja California"
--      Use metadata.municipio when present, else regex.
-- -----------------------------------------------------------------------------

-- 11.1 — seed cities from metadata.municipio (clean source).
INSERT INTO cities (country, slug, name)
SELECT DISTINCT 'MX', scrape_slugify(metadata->>'municipio'), metadata->>'municipio'
FROM professionals
WHERE source = 'cofepris-farmacias'
  AND metadata->>'municipio' IS NOT NULL
  AND scrape_slugify(metadata->>'municipio') <> ''
ON CONFLICT (country, slug) DO NOTHING;

-- 11.2 — apply when municipio is present.
UPDATE professionals
SET city_slug = scrape_slugify(metadata->>'municipio'),
    city_country = 'MX'
WHERE source = 'cofepris-farmacias'
  AND metadata->>'municipio' IS NOT NULL;

-- 11.3 — fallback: regex city from address for rows still without a slug.
-- Pattern: `\d{5}\s+(city words)\s+(state words)` — capture group 1.
-- Note: PostgreSQL regex `\d` works in ERE.
WITH parsed AS (
  SELECT id,
    (regexp_match(address, '\d{5}\s+([A-Za-zÀ-ÿ\.''\- ]+?)\s+[A-Z][a-zA-ZÀ-ÿ\s]+$'))[1] AS city_name
  FROM professionals
  WHERE source = 'cofepris-farmacias'
    AND address IS NOT NULL
    AND city_slug IS NULL
)
INSERT INTO cities (country, slug, name)
SELECT DISTINCT 'MX', scrape_slugify(city_name), city_name
FROM parsed WHERE city_name IS NOT NULL AND scrape_slugify(city_name) <> ''
ON CONFLICT (country, slug) DO NOTHING;

UPDATE professionals p
SET city_slug = scrape_slugify((regexp_match(p.address, '\d{5}\s+([A-Za-zÀ-ÿ\.''\- ]+?)\s+[A-Z][a-zA-ZÀ-ÿ\s]+$'))[1]),
    city_country = 'MX'
WHERE source = 'cofepris-farmacias'
  AND p.address IS NOT NULL
  AND city_slug IS NULL
  AND (regexp_match(p.address, '\d{5}\s+([A-Za-zÀ-ÿ\.''\- ]+?)\s+[A-Z][a-zA-ZÀ-ÿ\s]+$'))[1] IS NOT NULL;


-- =============================================================================
-- Sanity / reporting
-- =============================================================================

DO $$
DECLARE total bigint; with_country bigint; with_slug bigint; null_slug bigint;
BEGIN
  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE city_country IS NOT NULL),
         COUNT(*) FILTER (WHERE city_slug IS NOT NULL),
         COUNT(*) FILTER (WHERE city_slug IS NULL)
  INTO total, with_country, with_slug, null_slug FROM professionals;
  RAISE NOTICE 'FINAL: total=%, with_country=%, with_slug=%, null_slug=%',
    total, with_country, with_slug, null_slug;
END$$;

-- Per-country distribution after the bundle.
SELECT city_country, COUNT(*) AS pros
FROM professionals
GROUP BY city_country
ORDER BY pros DESC NULLS LAST;

-- Per (country, category) top-5 cities — confirms the matrix is no longer
-- concentrated.
WITH per_city AS (
  SELECT city_country, category_key, city_slug, COUNT(*) AS n
  FROM professionals
  WHERE city_slug IS NOT NULL
  GROUP BY city_country, category_key, city_slug
), ranked AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY city_country, category_key ORDER BY n DESC) AS rk
  FROM per_city
)
SELECT city_country, category_key, city_slug, n
FROM ranked
WHERE rk = 1
ORDER BY city_country, n DESC
LIMIT 30;
