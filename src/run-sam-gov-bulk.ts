/**
 * Standalone runner for the SAM.gov bulk re-ingest.
 *
 *   npm run sam-gov-bulk
 *
 * Same env contract as run-nppes-bulk.ts.
 */

import { createClient } from "@supabase/supabase-js";
import { runSamGovBulk } from "./sources/sam-gov-bulk.js";

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error("[sam-gov-bulk] missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  const client = createClient(url, serviceKey, { auth: { persistSession: false } });
  await runSamGovBulk(client);
}

main().catch((err) => {
  console.error("[sam-gov-bulk] failed:", err);
  process.exit(1);
});
