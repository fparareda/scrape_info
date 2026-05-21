/**
 * Reverse-geocode pros with lat/lng but no city_country. Picks the
 * nearest cities row within a ~0.5° bounding box.
 */
import { createClient } from "@supabase/supabase-js";
const c = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);
let chunk = 500, total = 0, pass = 0, errs = 0;
const t0 = Date.now();
while (true) {
  pass++;
  const { data, error } = await c.rpc("reverse_geocode_chunk", { chunk_size: chunk });
  if (error) {
    errs++;
    console.log(`pass ${pass}: ERROR ${error.message} (chunk=${chunk})`);
    if (errs >= 3 && chunk > 100) { chunk = Math.floor(chunk / 2); errs = 0; console.log(`  -> ${chunk}`); }
    if (errs >= 15) { console.log("giving up"); break; }
    await new Promise(r => setTimeout(r, 2000 * errs));
    continue;
  }
  errs = 0;
  const n = data ?? 0;
  total += n;
  if (n === 0) break;
  if (pass % 5 === 0) console.log(`pass ${pass}: total=${total.toLocaleString()} chunk=${chunk} ${((Date.now()-t0)/1000).toFixed(0)}s`);
}
console.log(`DONE: ${total.toLocaleString()} rows in ${pass} passes (${((Date.now()-t0)/1000).toFixed(1)}s)`);
