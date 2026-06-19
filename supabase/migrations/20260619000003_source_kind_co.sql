-- Register the Colombia bulk-registry source slugs in the source_kind enum.
-- professionals.source is an enum, so a new scraper's slug must be added here
-- before it can upsert (otherwise: "invalid input value for enum source_kind").
-- ADD VALUE IF NOT EXISTS is idempotent and must run outside a txn block.

alter type source_kind add value if not exists 'reps-salud-co';
alter type source_kind add value if not exists 'rues-registro-mercantil-co';
alter type source_kind add value if not exists 'secop-proveedores-co';
