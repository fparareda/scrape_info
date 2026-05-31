# Schema ownership

This repo (`scrape_info`) is a data factory that writes into prolio's Supabase
project (`wdniquikktnupzjnqyzw`). **All database schema is owned by prolio**
(`~/git/prolio`, `supabase/migrations/`). scrape_info does not maintain its own
migrations directory; if a scraper needs new schema, propose it on the prolio
side first.

See `~/.claude/projects/.../memory/project_independence.md` for the cross-repo
rule.

## Known schema applied to prod but not yet committed in prolio

These objects exist in prolio's Supabase (applied via MCP) but were not
captured as `supabase/migrations/*.sql` files in the prolio repo at the time
of writing. They are listed here so a maintainer can commit them in prolio.

### `20260521022132_coverage_matrix_city` — coverage matrix matview + refresh RPC

Used by `src/run-gmaps-gaps-queries.ts` in this repo (PR #71) to know which
`(country, city, category)` triples are already covered before generating the
next batch of Google Maps queries. The matview is refreshed at the start of
each cron shard so sequential shards see what earlier ones filled.

Reconstructed SQL (idempotent — safe to re-run):

```sql
-- Matview: coverage count per (country, city, category)
CREATE MATERIALIZED VIEW IF NOT EXISTS public.coverage_matrix_city AS
  SELECT
    city_country,
    city_slug,
    category_key,
    count(*)::integer AS n
  FROM public.professionals p
  WHERE city_slug IS NOT NULL
    AND city_country IS NOT NULL
    AND category_key IS NOT NULL
  GROUP BY city_country, city_slug, category_key;

-- Unique index required for REFRESH MATERIALIZED VIEW CONCURRENTLY
CREATE UNIQUE INDEX IF NOT EXISTS coverage_matrix_city_uniq
  ON public.coverage_matrix_city (city_country, city_slug, category_key);

-- Lookup index for per-country/city reads
CREATE INDEX IF NOT EXISTS coverage_matrix_city_country_slug_idx
  ON public.coverage_matrix_city (city_country, city_slug);

-- Refresh RPC (called from src/run-gmaps-gaps-queries.ts at start of each shard)
CREATE OR REPLACE FUNCTION public.refresh_coverage_matrix_city()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '300s'
AS $function$
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.coverage_matrix_city;
$function$;

-- Grants: EXECUTE granted to postgres, anon, authenticated, service_role in prod.
-- scrape_info calls it with the service_role key.
GRANT EXECUTE ON FUNCTION public.refresh_coverage_matrix_city() TO service_role;
```

To apply on a fresh environment, run the SQL above against the prolio Supabase
project (psql, Supabase SQL editor, or `supabase db push` after dropping it
into `prolio/supabase/migrations/<timestamp>_coverage_matrix_city.sql`).

**Recommended follow-up for the maintainer:** commit the above as
`prolio/supabase/migrations/20260521022132_coverage_matrix_city.sql` so prolio's
migration history matches the remote `supabase_migrations.schema_migrations`
table (which already records version `20260521022132`).

### `add_new_scrape_sources_2026_05_26` — source_kind enum additions

Applied via MCP on 2026-05-26 to unblock sink upserts for PR #85 (ABVMA + MVMA
vets), PR #99 (411.ca), and PR #100 (MerchantCircle US). PR #84 already left
a similar note for `uk-companies-house` / `sec-edgar` / `uspto-patentsview` —
those three were added in a previous round of this same kind of patch and now
live in the enum.

```sql
ALTER TYPE public.source_kind ADD VALUE IF NOT EXISTS 'abvma-ab-vets';
ALTER TYPE public.source_kind ADD VALUE IF NOT EXISTS 'mvma-mb-vets';
ALTER TYPE public.source_kind ADD VALUE IF NOT EXISTS '411-ca';
ALTER TYPE public.source_kind ADD VALUE IF NOT EXISTS 'merchantcircle-us';
```

### `add_gb_gphc_source_and_uk_cities` — GB country + GPhC slug + 15 UK cities

Applied via MCP on 2026-05-31 to unblock GPhC UK pharmacy professionals scraper
(PR #117). Two changes in one migration:

1. `ALTER TYPE source_kind ADD VALUE IF NOT EXISTS 'gphc-uk-pharmacists'`
2. `INSERT INTO cities` — 15 UK cities seeded for country='GB':
   London, Birmingham, Manchester, Glasgow, Leeds, Edinburgh, Liverpool,
   Bristol, Sheffield, Cardiff, Belfast, Nottingham, Newcastle, Leicester,
   Coventry.

```sql
ALTER TYPE public.source_kind ADD VALUE IF NOT EXISTS 'gphc-uk-pharmacists';

INSERT INTO public.cities (slug, name, country, lat, lng, region)
SELECT slug, name, country, lat, lng, region FROM (VALUES
  ('london','London','GB',51.5074,-0.1278,'ENG'),
  ('birmingham','Birmingham','GB',52.4862,-1.8904,'ENG'),
  ('manchester','Manchester','GB',53.4808,-2.2426,'ENG'),
  ('glasgow','Glasgow','GB',55.8642,-4.2518,'SCO'),
  ('leeds','Leeds','GB',53.8008,-1.5491,'ENG'),
  ('edinburgh','Edinburgh','GB',55.9533,-3.1883,'SCO'),
  ('liverpool','Liverpool','GB',53.4084,-2.9916,'ENG'),
  ('bristol','Bristol','GB',51.4545,-2.5879,'ENG'),
  ('sheffield','Sheffield','GB',53.3811,-1.4701,'ENG'),
  ('cardiff','Cardiff','GB',51.4816,-3.1791,'WAL'),
  ('belfast','Belfast','GB',54.5973,-5.9301,'NIR'),
  ('nottingham','Nottingham','GB',52.9548,-1.1581,'ENG'),
  ('newcastle','Newcastle','GB',54.9783,-1.6178,'ENG'),
  ('leicester','Leicester','GB',52.6369,-1.1398,'ENG'),
  ('coventry','Coventry','GB',52.4068,-1.5197,'ENG')
) AS v(slug, name, country, lat, lng, region)
WHERE NOT EXISTS (
  SELECT 1 FROM public.cities c WHERE c.slug = v.slug AND c.country = v.country
);
```

**Recurring gotcha:** every new scraper that calls `getSink().upsert(...)` must
have its slug added to this enum *before* its first GHA run, otherwise the
sink rejects every batch with `invalid input value for enum source_kind: "<slug>"`
and the run logs `inserted=0 updated=0` despite a non-zero `fetched`. The
existing `feat(intl)` commit (bf9a833) flagged this in the body — see the
"NOTE: prolio-side requires a migration…" line. The recommended workflow is:
either apply the `ALTER TYPE` migration *as part of the same PR* in prolio,
or run it via MCP/SQL editor right after merging here and before triggering
the workflow.
