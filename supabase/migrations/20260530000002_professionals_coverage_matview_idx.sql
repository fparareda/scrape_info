-- Composite index on professionals(city_country, city_slug, category_key)
-- to allow index-only scan during REFRESH MATERIALIZED VIEW CONCURRENTLY
-- on coverage_matrix_city. Without this, the refresh does a full scan of
-- the ~9.5 GB table, exceeding the 300s statement_timeout on the RPC.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_professionals_city_country_slug_cat
  ON public.professionals (city_country, city_slug, category_key)
  WHERE city_country IS NOT NULL
    AND city_slug IS NOT NULL
    AND category_key IS NOT NULL;
