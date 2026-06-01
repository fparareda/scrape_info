-- Fix refresh_coverage_matrix() — was missing SECURITY DEFINER and
-- statement_timeout, so it inherited the authenticator role's 8s session
-- timeout and failed every time (code 57014). Now mirrors
-- refresh_coverage_matrix_city() which already had the 300s override.
CREATE OR REPLACE FUNCTION public.refresh_coverage_matrix()
  RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO 'public', 'pg_temp'
  SET statement_timeout TO '300s'
AS $$
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.coverage_matrix;
$$;
