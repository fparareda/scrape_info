/**
 * Standalone runner for catalog.data.gov Socrata-backed sources.
 *
 *   pnpm tsx src/run-data-gov-bulk.ts --source=montgomery-md-electrician
 *   pnpm tsx src/run-data-gov-bulk.ts --source=montgomery-md-electrician --dry-run --max=100
 *
 * Reads SUPABASE creds from env (NEXT_PUBLIC_SUPABASE_URL or
 * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY). Designed for local
 * iteration — `.env.local` is loaded if present.
 *
 * Sources auto-create unknown rows in `public.cities` via
 * `ensureCity()`, so the data.gov path can ingest municipalities not
 * present in the static seed catalogue.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";
import { runMontgomeryMdElectrician } from "./sources/data-gov-montgomery-md-electrician.js";
import { runChicagoBacp } from "./sources/data-gov-chicago-bacp.js";

interface CliOpts {
  source: string;
  maxRows?: number;
  batchSize?: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = { source: "", dryRun: false };
  for (const arg of argv) {
    if (arg.startsWith("--source=")) opts.source = arg.slice("--source=".length);
    else if (arg.startsWith("--max=")) opts.maxRows = Number(arg.slice("--max=".length));
    else if (arg.startsWith("--batch=")) opts.batchSize = Number(arg.slice("--batch=".length));
    else if (arg === "--dry-run") opts.dryRun = true;
  }
  return opts;
}

function loadDotEnvLocal(): void {
  const path = ".env.local";
  if (!existsSync(path)) return;
  const txt = readFileSync(path, "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = val;
  }
}

type Runner = (
  client: SupabaseClient,
  opts: { maxRows?: number; batchSize?: number; dryRun?: boolean },
) => Promise<{ scanned: number; accepted: number; written: number }>;

const SOURCES: Record<string, Runner> = {
  "montgomery-md-electrician": runMontgomeryMdElectrician,
  "chicago-bacp": runChicagoBacp,
};

async function main(): Promise<void> {
  loadDotEnvLocal();
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.source) {
    console.error(
      `usage: run-data-gov-bulk --source=<name> [--max=N] [--batch=N] [--dry-run]\n` +
        `available sources: ${Object.keys(SOURCES).join(", ")}`,
    );
    process.exit(1);
  }
  const runner = SOURCES[opts.source];
  if (!runner) {
    console.error(`[data-gov] unknown source '${opts.source}'`);
    console.error(`available: ${Object.keys(SOURCES).join(", ")}`);
    process.exit(1);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error("[data-gov] missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  const client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  console.log(
    `[data-gov] running source=${opts.source} maxRows=${opts.maxRows ?? "∞"} ` +
      `batchSize=${opts.batchSize ?? 500} dryRun=${opts.dryRun}`,
  );
  const t0 = Date.now();
  const result = await runner(client, opts);
  console.log(
    `[data-gov] done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ` +
      `scanned=${result.scanned} accepted=${result.accepted} written=${result.written}`,
  );
}

main().catch((err) => {
  console.error("[data-gov] failed:", err);
  process.exit(1);
});
