-- Lower autovacuum thresholds for professionals table.
-- Default scale_factor=0.2 means autovacuum waits for 780K dead tuples
-- on a 3.8M-row table before running. With continuous scraper inserts
-- and updates, this leads to bloat and slow query plans.
-- New settings fire at ~196K dead tuples (5% of live rows).
ALTER TABLE public.professionals SET (
  autovacuum_vacuum_scale_factor  = 0.05,
  autovacuum_vacuum_threshold     = 1000,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_analyze_threshold    = 500
);
