/**
 * Overture Maps source.
 *
 * Overture is a joint Meta + Microsoft + Amazon + TomTom open-data
 * map. Licence: CDLA-Permissive-2.0 (weaker copyleft than OSM ODbL —
 * fine for our redistribution + DB storage). Covers places, buildings,
 * transportation, divisions and addresses.
 *
 * Strategy:
 *   1. Download the latest `places` Parquet dataset from S3
 *      (s3://overturemaps-us-west-2/release/<date>/theme=places/).
 *   2. Query with DuckDB (in-process, no server) filtered by country
 *      codes ES/CA/US and by category codes that map to Prolio's 9
 *      categories.
 *   3. Stream matches through `normalise()` + the sink.
 *
 * Why this is a scaffold and not a finished source:
 *   - Requires adding `@duckdb/node-api` (~15MB native). Not worth
 *     shipping until we've validated coverage + category mapping
 *     against a real query.
 *   - The Overture category taxonomy is a 500+ entry tree. We need to
 *     hand-map Prolio categories to Overture IDs and iterate when
 *     coverage looks thin.
 *   - Monthly release snapshots shift — the connection string in S3
 *     is versioned by date and needs to be bumped.
 *
 * Run pattern (once implemented):
 *   PROLIO_SCRAPE_OVERTURE=true \
 *   PROLIO_OVERTURE_COUNTRIES="ES,CA,US" \
 *   pnpm --filter @prolio/scraper scrape
 *
 * Expected Spain+Canada+USA places subset: ~1-2GB Parquet, processable
 * in under 10 minutes on a modest machine. Free, no API key, no per-
 * query quota.
 */

import type { ScrapedProfessional } from "../types.js";

export async function runOvertureEnrichment(): Promise<ScrapedProfessional[]> {
  console.warn(
    "[overture] source scaffolded but not implemented yet — requires DuckDB + category mapping. See comment block in this file.",
  );
  return [];
}

export function overtureEnabled(): boolean {
  return process.env.PROLIO_SCRAPE_OVERTURE === "true";
}

/**
 * IMPLEMENTATION CHECKLIST (when we activate):
 *
 *  [ ] `pnpm --filter @prolio/scraper add @duckdb/node-api`
 *  [ ] Write CATEGORY_MAP: Record<CategoryKey, string[]> with
 *      Overture's `primary_category` values. Start from
 *      https://docs.overturemaps.org/guides/places/
 *  [ ] Write COUNTRY_CODE_FILTER using addresses.country ISO codes.
 *  [ ] Connect DuckDB to the S3 bucket (httpfs extension + S3
 *      credentials — the Overture bucket is public, so just need
 *      region=us-west-2).
 *  [ ] SELECT id, names, categories, phones, websites, emails, addresses,
 *      geometry, confidence FROM read_parquet('s3://.../places/*.parquet')
 *      WHERE addresses[1].country IN ('ES','CA','US')
 *      AND categories.primary IN (<prolio-mapped set>).
 *  [ ] Map rows to ScrapedProfessional with source="overture" (add
 *      enum value in a migration before enabling).
 *  [ ] Add chunked upsert — Overture for 3 countries ≈ 2M+ rows before
 *      filtering; filtered to Prolio categories probably 50k-100k.
 *      Stream through sink in 5k batches.
 *  [ ] Telegram alert on download failures (S3 may rate-limit).
 */
