-- Sprint 0 — Cross-country slug collision fix.
--
-- PROBLEM (verified): cities.slug is unique table-wide, so when a scraper for
-- country B emits city_slug=X and a city with slug X exists only in country A,
-- the row lands in country A. ~5,500 rows are mis-assigned today.
--
-- FIX: make cities PK composite (country, slug) and propagate to professionals.
--
-- BLAST RADIUS: writes to cities, professionals. ~1.14M rows in professionals.
--               Backfill UPDATE is the heavy step; run it in chunks if needed.
--
-- Run as a single transaction. Roll back if any step fails.

BEGIN;

-- 1. cities: composite PK on (country, slug)
ALTER TABLE cities DROP CONSTRAINT IF EXISTS cities_pkey;
-- If there was a UNIQUE on slug alone, drop it too
ALTER TABLE cities DROP CONSTRAINT IF EXISTS cities_slug_key;
ALTER TABLE cities ADD CONSTRAINT cities_pkey PRIMARY KEY (country, slug);

-- 2. professionals: add city_country, populate, then make composite FK
ALTER TABLE professionals ADD COLUMN IF NOT EXISTS city_country char(2);

-- Best-effort initial population from existing single-country city map.
-- After this, ~5,500 rows still point at the wrong country (the A-BIS bug);
-- the backfill in sprint-0-backfill.sql corrects them.
UPDATE professionals p
SET city_country = (
  SELECT country FROM cities c WHERE c.slug = p.city_slug LIMIT 1
)
WHERE p.city_slug IS NOT NULL AND p.city_country IS NULL;

-- 3. New composite FK; drop the old slug-only FK first
ALTER TABLE professionals DROP CONSTRAINT IF EXISTS professionals_city_slug_fkey;
ALTER TABLE professionals
  ADD CONSTRAINT professionals_city_fkey
  FOREIGN KEY (city_country, city_slug)
  REFERENCES cities(country, slug)
  DEFERRABLE INITIALLY DEFERRED;

-- 4. Helpful indexes for the new access pattern
CREATE INDEX IF NOT EXISTS idx_professionals_country_city
  ON professionals(city_country, city_slug);
CREATE INDEX IF NOT EXISTS idx_professionals_country_category
  ON professionals(city_country, category_key);

COMMIT;

-- Post-migration sanity checks (run separately, not in tx):
--
--   -- 0. No rows should violate the new FK (we made it deferrable so this
--   --    is your last chance to spot trouble).
--   SELECT COUNT(*) FROM professionals p
--   LEFT JOIN cities c ON c.country = p.city_country AND c.slug = p.city_slug
--   WHERE p.city_slug IS NOT NULL AND c.slug IS NULL;
--
--   -- 1. Distribution: every city_country now has a non-trivial row count
--   SELECT city_country, COUNT(*) FROM professionals GROUP BY city_country;
--
--   -- 2. ~5,500 rows still mis-assigned (correct in backfill script)
--   --    These are rows whose source declares country X but city_country = Y
