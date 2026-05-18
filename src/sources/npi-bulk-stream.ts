import type { ScraperSource } from "../types.js";
import { runNpi } from "./npi.js";

/**
 * NPI Bulk Stream (alias / variant) — runs the existing npi.ts pipeline.
 *
 * The base `npi.ts` source already implements the bulk-stream strategy
 * exactly as the spec demands: it pulls the monthly ZIP from
 * `https://download.cms.gov/nppes/NPI_Files.html` (or the weekly diff),
 * decompresses entry-by-entry, parses the CSV line by line, applies the
 * taxonomy → CategoryKey filter (medicine, dentistry, vet, plus newly
 * added enfermeria + farmacia in 2026-05-18), and upserts in batches.
 *
 * The "full bulk" mode is too heavy for a stock GH Actions runner (~1 GB
 * download → ~5 GB CSV inflate, ~7M rows). The default profile already:
 *   - downloads the weekly diff (~6 MB) — always cheap
 *   - honours `PROLIO_NPI_LIMIT_PER_RUN` (we raise the workflow default
 *     here to 1,000,000 for the explicit bulk variant)
 *   - exposes `PROLIO_NPI_INGEST_FULL_MONTHLY=true` for the opt-in full
 *     monthly when run from a beefier host
 *
 * `npi-bulk-stream` exists as a separate scrape slug so it can be
 * cron'd / triggered independently of the regular weekly `npi` job
 * (which keeps the small per-run cap appropriate for CI). When the user
 * runs the `npi-bulk-stream` workflow we set
 * `PROLIO_NPI_INGEST_FULL_MONTHLY=true` and `PROLIO_NPI_LIMIT_PER_RUN=1000000`
 * via the runner — that's all that's needed. No new parsing code.
 *
 * This file is intentionally a thin re-export — it documents WHY the
 * partial / streaming approach (vs naive in-memory load of 5 GB) is the
 * correct shape, and lets us wire a distinct workflow/cron without
 * touching the proven npi.ts pipeline.
 */

export const npiBulkStreamSource: ScraperSource = {
  name: "npi-bulk-stream",
  enabled() {
    return process.env.PROLIO_RUN_NPI_BULK_STREAM === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runNpiBulkStream(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!npiBulkStreamSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  // Force the bulk-mode envs (idempotent overrides; user can still set
  // them explicitly on the workflow).
  process.env.PROLIO_RUN_NPI = "true";
  process.env.PROLIO_NPI_INGEST_FULL_MONTHLY =
    process.env.PROLIO_NPI_INGEST_FULL_MONTHLY ?? "true";
  process.env.PROLIO_NPI_LIMIT_PER_RUN =
    process.env.PROLIO_NPI_LIMIT_PER_RUN ?? "1000000";
  await runNpi();
  // runNpi reports inside its own logs; the runner harness already has
  // a row-count signal from withScrapeRun in the npi block. We return
  // zeros here to avoid double-counting.
  return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
}
