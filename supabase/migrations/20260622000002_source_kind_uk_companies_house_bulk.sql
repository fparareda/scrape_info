-- Add the 'uk-companies-house-bulk' value to the professionals.source enum
-- (source_kind). This is the full-register ingest of the Companies House free
-- bulk snapshot (~5M UK companies), kept separate from the existing
-- 'uk-companies-house' API source (enrichment-only) so /admin telemetry and
-- per-source counts stay legible — mirrors the denue-bulk / sirene-bulk split.
--
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block in older
-- Postgres; IF NOT EXISTS makes it idempotent for re-runs.
ALTER TYPE source_kind ADD VALUE IF NOT EXISTS 'uk-companies-house-bulk';
