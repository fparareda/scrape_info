/**
 * Backfill legacy `category_key='extranjeria'` rows that should be
 * `abogado` after the PR #55 + #53 routing fixes. Runs source by source
 * because each source can be re-classified individually and the rate of
 * progress varies.
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing env"); process.exit(1); }
const c = createClient(url, key, { auth: { persistSession: false } });

const SOURCES = ["denue-mx", "sirene-insee", "cnb-avocats", "lsnb-bar", "lss-saskatchewan"];

for (const source of SOURCES) {
  console.log(`\n=== ${source} ===`);
  let chunk = 2000, total = 0, pass = 0, errs = 0;
  while (true) {
    pass++;
    const { data, error } = await c.rpc("backfill_extranjeria_to_abogado_chunk", { p_source: source, chunk_size: chunk });
    if (error) {
      errs++;
      console.log(`  pass ${pass}: ERROR ${error.message} (chunk=${chunk})`);
      if (errs >= 3 && chunk > 100) { chunk = Math.max(100, Math.floor(chunk/2)); errs = 0; console.log(`    -> shrunk to ${chunk}`); }
      if (errs >= 10) { console.log("  giving up"); break; }
      await new Promise(r => setTimeout(r, 2000 * errs));
      continue;
    }
    errs = 0;
    const n = data ?? 0;
    total += n;
    if (n === 0) break;
    if (pass % 5 === 0) console.log(`  pass ${pass}: ${total} (chunk=${chunk})`);
  }
  console.log(`  DONE ${source}: ${total} rows`);
}
console.log("\nAll done.");
