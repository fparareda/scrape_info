-- Resume checkpoint for paginated bulk scrapers that can't finish in one CI
-- window (e.g. SECOP, 1.58M rows). Stores the next Socrata $offset to fetch;
-- reset to 0 when a full pass completes. See src/sources/secop-proveedores-co.ts.
create table if not exists public.scrape_cursor (
  source      text primary key,
  next_offset bigint not null default 0,
  updated_at  timestamptz not null default now()
);
