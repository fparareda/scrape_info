/**
 * Standalone runner for the UK Companies House free bulk snapshot ingest.
 *
 *   npm run uk-ch-bulk
 *
 * The GitHub workflow downloads + unzips the monthly snapshot to /tmp and
 * exports the extracted CSV paths via PROLIO_UK_CH_BULK_FILES (comma-separated)
 * or a directory via PROLIO_UK_CH_BULK_DIR. This entrypoint streams them
 * through src/sources/uk-companies-house-bulk.ts (ensureCity no-drop + resume
 * cursor) and records a scrape_runs row with a live heartbeat so a CI-killed
 * run still reflects the rows it wrote.
 *
 * Env:
 *   SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (required)
 *   PROLIO_UK_CH_BULK_FILES   comma-separated CSV paths (takes precedence)
 *   PROLIO_UK_CH_BULK_DIR     directory of BasicCompanyData*.csv files
 *   PROLIO_UK_CH_BULK_LIMIT   per-run row cap (also accepts --limit=N)
 *   PROLIO_UK_CH_ACTIVE_ONLY  "true" to ingest only Active companies
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { runUkCompaniesHouseBulk, resolveCsvPaths } from "./sources/uk-companies-house-bulk.js";
import { beginScrapeRun } from "./telemetry.js";

function resolvePaths(): string[] {
  const explicit = resolveCsvPaths();
  if (explicit.length > 0) return explicit;
  const dir = process.env.PROLIO_UK_CH_BULK_DIR;
  if (!dir) return [];
  return readdirSync(dir)
    .filter((f) => /^BasicCompanyData.*\.csv$/i.test(f))
    .sort()
    .map((f) => join(dir, f));
}

function resolveLimit(): number | undefined {
  const arg = process.argv.find((a) => a.startsWith("--limit="));
  const raw = arg ? arg.slice("--limit=".length) : process.env.PROLIO_UK_CH_BULK_LIMIT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error("[uk-ch-bulk] missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  const csvPaths = resolvePaths();
  if (csvPaths.length === 0) {
    console.error(
      "[uk-ch-bulk] no CSV paths — set PROLIO_UK_CH_BULK_FILES or PROLIO_UK_CH_BULK_DIR",
    );
    process.exit(1);
  }
  console.log(`[uk-ch-bulk] ${csvPaths.length} file(s): ${csvPaths.join(", ")}`);

  const client = createClient(url, serviceKey, { auth: { persistSession: false } });
  const run = await beginScrapeRun("uk-companies-house-bulk");
  try {
    const { scanned, accepted, written } = await runUkCompaniesHouseBulk(client, {
      csvPaths,
      maxRows: resolveLimit(),
      onProgress: (p) =>
        run.heartbeat({ rowsFetched: p.fetched, rowsUpserted: p.upserted, rowsSkipped: p.skipped }),
    });
    await run.ok({
      rowsFetched: accepted,
      rowsUpserted: written,
      rowsSkipped: scanned - accepted,
    });
  } catch (err) {
    await run.error(err);
    throw err;
  }
}

main().catch((err) => {
  console.error("[uk-ch-bulk] failed:", err);
  process.exit(1);
});
