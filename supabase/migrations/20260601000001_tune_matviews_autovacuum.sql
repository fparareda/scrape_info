-- Tune autovacuum for v_combo_counts and coverage_matrix_city matviews.
-- Both accumulate dead tuples from frequent REFRESH cycles but inherit
-- the default 20% scale_factor — too loose for views refreshed daily.
-- Setting 5% fires autovacuum much sooner and keeps bloat in check.
ALTER TABLE public.v_combo_counts SET (
  autovacuum_vacuum_scale_factor  = 0.05,
  autovacuum_vacuum_threshold     = 500,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_analyze_threshold    = 200
);
ALTER TABLE public.coverage_matrix_city SET (
  autovacuum_vacuum_scale_factor  = 0.05,
  autovacuum_vacuum_threshold     = 500,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_analyze_threshold    = 200
);
