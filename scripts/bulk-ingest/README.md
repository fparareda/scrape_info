# Bulk-ingest pipeline

Local scripts for high-throughput ingest of million-row open-data sources
(DENUE / Overture Places / OpenStreetMap PBF) into `professionals`.

> **TL;DR** — Running these locally hits **~200–1000 rows/sec**, vs.
> **~0.6 rows/sec** for the equivalent GHA + supabase-js sources. A 2M-row
> import that GHA can't finish in 3h completes locally in **~30–60 min**.

## Why local, not GitHub Actions?

| Layer                                       | Throughput      |
| ------------------------------------------- | --------------- |
| GHA runner ↔ Supabase (supabase-js client)  | ~0.6 rows/sec   |
| Local laptop ↔ Supabase REST (this pipeline)| 200–1000 rows/s |

The GHA path is bottlenecked by three things, all of which we sidestep:

1. **Latency.** GHA runners are usually US-east; Supabase project is EU. Every
   batch round-trip pays 90–150ms.
2. **Sink overhead.** Our `_bulk-utils` sink does a `cities` lookup per row,
   buffers in memory, and posts via supabase-js — adding ~30ms per row.
3. **GHA hard ceiling.** Jobs die at 6h, and our concurrency limits cut a long
   job before the queue drains.

The local pipeline does the opposite: pre-caches `cities` once, batches 500
rows per POST, runs 3–6 batches in flight, and talks directly to the REST
endpoint with the service-role key — no client library.

## Prereqs

- **Node 22+** (only Node built-ins + `fetch`).
- **DuckDB** for Overture: `brew install duckdb`.
- **osmium-tool** for OSM: `brew install osmium-tool`.
- `.env.local` at the repo root with:
  ```env
  NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
  SUPABASE_SERVICE_ROLE_KEY=eyJh...
  ```
- ~12GB free disk (PBFs + extracted CSVs + Overture CSVs).
- Stable network — these pulls multi-GB files from Geofabrik / Overture S3.

## Usage

```bash
# Mexico DENUE — ~600k rows, 30–40 min
npm run bulk:denue

# Overture Places — all 5 countries (US/CA/ES/FR/MX), ~1.2M rows, ~60 min
npm run bulk:overture
# Or just one country:
node scripts/bulk-ingest/overture.mjs US

# OpenStreetMap PBF — specify countries
npm run bulk:osm -- ES CA MX
```

Re-runs are safe: ON CONFLICT IGNORE on `(source, source_id)` means
re-ingesting just no-ops for existing rows. Intended cadence: **monthly**.

## Where the data comes from

- **DENUE (MX)** — INEGI's open business registry. Bulk ZIP per state at
  `https://www.inegi.org.mx/contenidos/masiva/denue/denue_<CVE>_csv.zip`.
- **Overture Places** — `s3://overturemaps-us-west-2/release/<YYYY-MM-DD.N>/theme=places/`,
  queried in-place via DuckDB + httpfs. Bump `OVERTURE_RELEASE` env to pick a
  newer release.
- **OSM PBF** — Geofabrik regional extracts
  (`https://download.geofabrik.de/<region>/<country>-latest.osm.pbf`).

## Expected row counts (kept, post-filter)

| Source        | US   | CA  | ES  | FR  | MX  |
| ------------- | ---- | --- | --- | --- | --- |
| DENUE (bulk)  | —    | —   | —   | —   | ~600k |
| Overture      | ~800k| ~80k| ~120k| ~150k| ~50k |
| OSM PBF       | ~600k| ~50k| ~80k | ~120k| ~40k |

Numbers are rough; depend on the SCIAN/category map and city-resolution rate.

## Architecture

```
  ┌────────────────────┐
  │ extract+parse      │  (per source)
  │  - DuckDB / osmium │
  │  - ZIP+CSV parser  │
  └─────────┬──────────┘
            │  payload objects
            ▼
  ┌────────────────────────────┐
  │ _lib/rest-uploader.mjs     │
  │  push(row) → buffer        │
  │  ↳ flush when ≥ batchSize  │
  │     ↳ POST /rest/v1/...    │
  │        ↳ on 57014 / 23505  │
  │           halve → retry    │
  └────────────────────────────┘
```

Three shared building blocks live in `_lib/`:

- **`env.mjs`** — parses `.env.local`, exposes `requireSupabase()`.
- **`cities.mjs`** — caches the `cities` table per country once at startup
  (paginated REST GET). Exposes `resolveCity()` (name → slug fallback chain)
  and `nearestCity()` (lat/lng proximity within ~55km).
- **`rest-uploader.mjs`** — `createUploader({ batchSize, concurrency })`
  returns `{ push, flush, done }`. Stream-and-flush keeps memory bounded; the
  `postBatch` halves on Postgres statement-timeout or unique-violation and
  retries 503/504/408 with backoff.

## Lessons learned (informs the design)

- **Header row consumption.** Early versions of the DENUE parser stripped the
  header in the loop body, so the first CSV row leaked through with empty
  cells and the `cols` index resolved to `-1` everywhere. Fix: header is set
  on the first call and the function returns immediately — see
  `denue-mx-bulk.mjs` `iterateCsvRows` callback.
- **`city_country` NOT NULL.** The `professionals.city_country` column is
  required; missing it returns a 400 on the entire batch (not just the bad
  row). Always set it explicitly from the source country.
- **Proximity fallback for OSM.** Many OSM POIs lack `addr:city` but have
  precise lat/lng. We do a bounding-box-pruned nearest-city search within
  ~55km — recovers ~30% of otherwise-dropped rows in ES / FR.
- **Concurrency sweet spot.** 3 workers for DENUE/OSM (city lookups
  dominate), 6 for Overture (raw row throughput). Past 6, Cloudflare in
  front of Supabase starts rate-limiting at ~30% of requests.
- **Parallel processes are counter-productive past 6.** We tried running
  3 OS processes × 6 workers each. Throughput dropped 40% because all the
  workers competed for the same Cloudflare rate-limit budget. One process
  with 6 workers is optimal.
- **Stream-and-flush, not load-then-batch.** The first Overture upload built
  the full 800k-row array in memory before POSTing — peaked at ~6GB RSS.
  Stream-and-flush (push as you parse, fire batches as buffer fills) keeps
  RSS under 800MB.
- **DuckDB beats downloading parquet.** DuckDB queries Overture S3
  parquet directly via `httpfs`; no need to download 50GB of parquet to
  filter to 800k rows.

## Known limits

- **Supabase statement timeout** is ~60s on free tier, ~120s on pro. A
  500-row batch with conflict-checking + RLS evaluation can hit it on big
  tables. The halving retry handles this gracefully but each halve costs a
  round-trip — keep `batchSize` at 500 or below.
- **Cloudflare rate-limits at high concurrency.** Above ~6 in-flight POSTs to
  the same Supabase project, ~30% of requests come back 503. The retry-on-503
  logic recovers but throughput collapses. Stick to `concurrency: 3-6`.
- **No streaming write progress on disk.** If the script crashes mid-flush,
  the in-flight batch is lost — but ON CONFLICT IGNORE makes re-runs idempotent,
  so just re-run.
- **Overture release path is hardcoded.** Bump `OVERTURE_RELEASE` env when
  Overture publishes a new monthly release.
