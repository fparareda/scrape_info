/**
 * Standalone runner for the IRS BMF bulk re-ingest.
 *
 *   npm run irs-bmf-bulk
 *
 * Same env contract as run-nppes-bulk.ts.
 */

import { createClient } from "@supabase/supabase-js";
import { runIrsBmfBulk } from "./sources/irs-bmf-bulk.js";

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error("[irs-bmf-bulk] missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  const client = createClient(url, serviceKey, { auth: { persistSession: false } });
  await runIrsBmfBulk(client);
}

main().catch((err) => {
  console.error("[irs-bmf-bulk] failed:", err);
  process.exit(1);
});
