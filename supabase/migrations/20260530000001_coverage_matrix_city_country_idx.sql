-- Index on coverage_matrix_city(city_country) to avoid full-table-scan
-- on paginated reads from the GHA scrape-gmaps-gaps workflow.
-- Without this index, PostgREST's 60s statement_timeout is exceeded for
-- large countries (MX: 2459 cities × N categories).
CREATE INDEX IF NOT EXISTS coverage_matrix_city_country_idx
  ON public.coverage_matrix_city (city_country);
