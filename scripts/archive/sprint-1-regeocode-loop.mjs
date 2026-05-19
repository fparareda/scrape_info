/**
 * Sprint 1 regeocode runner. Loops the regeocode_from_metadata() RPC for
 * each (source, country, metadata_key) tuple until 0 rows returned.
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing env"); process.exit(1); }
const client = createClient(url, key, { auth: { persistSession: false } });

const JOBS = [
  { source: "apega",                country: "CA", key: "raw_city" },
  { source: "tsask",                country: "CA", key: "raw_city" },
  { source: "cpsns-ns-physicians",  country: "CA", key: "practice_location" },
  { source: "cofepris-farmacias",   country: "MX", key: "municipio" },
];

let totalChunk = Number(process.env.CHUNK ?? "2000");

async function runJob(job) {
  console.log(`\n=== ${job.source} (${job.country}, key=${job.key}) ===`);
  let chunk = totalChunk;
  let total = 0, pass = 0, consecutiveErrors = 0;
  const start = Date.now();
  while (true) {
    pass++;
    const { data, error } = await client.rpc("regeocode_from_metadata", {
      p_source: job.source, p_country: job.country, p_meta_key: job.key, chunk_size: chunk
    });
    if (error) {
      consecutiveErrors++;
      console.log(`  pass ${pass}: ERROR ${error.message} (chunk=${chunk})`);
      if (consecutiveErrors >= 3 && chunk > 100) {
        chunk = Math.max(100, Math.floor(chunk / 2));
        console.log(`    -> shrunk to ${chunk}`);
        consecutiveErrors = 0;
      }
      if (consecutiveErrors >= 10) { console.log("  giving up"); break; }
      await new Promise(r => setTimeout(r, 2000 * consecutiveErrors));
      continue;
    }
    consecutiveErrors = 0;
    const n = data ?? 0;
    total += n;
    if (pass % 5 === 0 || n === 0) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`  pass ${pass}: +${n} (total ${total.toLocaleString()}, chunk=${chunk}, ${elapsed}s)`);
    }
    if (n === 0) break;
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`  DONE ${job.source}: ${total.toLocaleString()} rows in ${pass} passes (${elapsed}s)`);
}

for (const job of JOBS) await runJob(job);
console.log("\nAll jobs done.");
