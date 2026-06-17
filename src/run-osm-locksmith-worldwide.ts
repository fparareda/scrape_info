/**
 * Standalone runner for the worldwide OSM locksmith bulk re-ingest.
 *
 *   npm run osm-locksmith-worldwide
 *
 * Mirrors run-nppes-bulk.ts: reads creds from env and fails loudly if
 * they're missing rather than falling back silently.
 */

import { createClient } from "@supabase/supabase-js";
import { runOsmLocksmithWorldwide } from "./sources/osm-locksmith-worldwide.js";

async function main(): Promise<void> {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error(
      "[osm-locksmith] missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
    );
    process.exit(1);
  }
  const client = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });
  await runOsmLocksmithWorldwide(client);
}

main().catch((err) => {
  console.error("[osm-locksmith] failed:", err);
  process.exit(1);
});
