/**
 * Backfill professionals.city_country via RPC in a loop until 0 rows
 * returned. Tolerates timeouts (retries with backoff and shrinks chunk).
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing env"); process.exit(1); }
const client = createClient(url, key, { auth: { persistSession: false } });

let chunk = Number(process.env.CHUNK ?? "1000");
const MIN_CHUNK = 100;
let total = 0, pass = 0, consecutiveErrors = 0;
const start = Date.now();

function elapsed() { return ((Date.now() - start) / 1000).toFixed(1) + "s"; }

while (true) {
  pass++;
  const { data, error } = await client.rpc("backfill_city_country_chunks", { chunk_size: chunk });
  if (error) {
    consecutiveErrors++;
    const wait = Math.min(2000 * consecutiveErrors, 10000);
    console.log(`pass ${pass}: ERROR ${error.message} (chunk=${chunk}, retry in ${wait}ms)`);
    if (consecutiveErrors >= 3 && chunk > MIN_CHUNK) {
      chunk = Math.max(MIN_CHUNK, Math.floor(chunk / 2));
      console.log(`  -> shrunk chunk to ${chunk}`);
      consecutiveErrors = 0;
    }
    if (consecutiveErrors >= 10) {
      console.log("  -> 10 consecutive failures, giving up");
      break;
    }
    await new Promise((r) => setTimeout(r, wait));
    continue;
  }
  consecutiveErrors = 0;
  const n = data ?? 0;
  total += n;
  if (pass % 10 === 0 || n === 0) {
    console.log(`pass ${pass}: +${n} (total ${total.toLocaleString()}, chunk=${chunk}, ${elapsed()})`);
  }
  if (n === 0) break;
}

console.log(`DONE: ${total.toLocaleString()} rows updated in ${pass} passes (${elapsed()})`);
