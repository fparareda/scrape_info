/**
 * Standalone runner for the NPI bulk re-ingest.
 *
 *   pnpm --filter @prolio/scraper nppes-bulk
 *
 * Reads `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from env (the
 * .env.local fallback that the orchestrator does is intentionally
 * skipped — this script is meant to run from CI and should fail loudly
 * if creds are missing rather than silently target a stale fallback).
 */

import { createClient } from "@supabase/supabase-js";
import { runNppesBulk } from "./sources/nppes-bulk.js";

async function main(): Promise<void> {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error(
      "[nppes-bulk] missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
    );
    process.exit(1);
  }
  const client = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });
  await runNppesBulk(client);
}

main().catch((err) => {
  console.error("[nppes-bulk] failed:", err);
  process.exit(1);
});
