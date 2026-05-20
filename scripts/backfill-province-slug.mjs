/**
 * Backfill metadata.province_slug for rows with city_slug=NULL that
 * are missing province_slug. Unblocks subsequent UPDATEs that would
 * otherwise fail the province_when_slug_null CHECK constraint.
 */
import { createClient } from "@supabase/supabase-js";
const c = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);
let chunk = 2000, total = 0, pass = 0, errs = 0;
const t0 = Date.now();
while (true) {
  pass++;
  const { data, error } = await c.rpc("backfill_province_slug_chunk", { chunk_size: chunk });
  if (error) {
    errs++;
    console.log(`pass ${pass}: ERROR ${error.message} (chunk=${chunk})`);
    if (errs >= 3 && chunk > 100) { chunk = Math.floor(chunk / 2); errs = 0; console.log(`  -> ${chunk}`); }
    if (errs >= 10) { console.log("giving up"); break; }
    await new Promise(r => setTimeout(r, 2000 * errs));
    continue;
  }
  errs = 0;
  const n = data ?? 0;
  total += n;
  if (n === 0) break;
  if (pass % 5 === 0) console.log(`pass ${pass}: +${n} (total ${total})`);
}
console.log(`DONE: ${total} rows in ${pass} passes (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
