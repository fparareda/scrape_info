/**
 * Sprint 1 regeocode v2 — keyset by id. Avoids the slow filter on
 * city_slug IS DISTINCT FROM slugify(...) which forced per-row function
 * evaluation. Each call: pick next 500 rows of source by id > last_id,
 * update those whose metadata key maps to a known city.
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing env"); process.exit(1); }
const client = createClient(url, key, { auth: { persistSession: false } });

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const CHUNK = Number(process.env.CHUNK ?? "500");

const JOBS = [
  { source: "apega",                country: "CA", key: "raw_city" },
  { source: "tsask",                country: "CA", key: "raw_city" },
  { source: "cpsns-ns-physicians",  country: "CA", key: "practice_location" },
  { source: "cofepris-farmacias",   country: "MX", key: "municipio" },
];

async function runJob(job) {
  console.log(`\n=== ${job.source} (${job.country}, key=${job.key}) ===`);
  let chunk = CHUNK;
  let lastId = ZERO_UUID;
  let totalSeen = 0, totalUpdated = 0, pass = 0, consecutive = 0;
  const start = Date.now();
  while (true) {
    pass++;
    const { data, error } = await client.rpc("regeocode_v2", {
      p_source: job.source,
      p_country: job.country,
      p_meta_key: job.key,
      p_after_id: lastId,
      chunk_size: chunk,
    });
    if (error) {
      consecutive++;
      console.log(`  pass ${pass}: ERROR ${error.message} (chunk=${chunk})`);
      if (consecutive >= 3 && chunk > 50) {
        chunk = Math.max(50, Math.floor(chunk / 2));
        console.log(`    -> shrunk to ${chunk}`);
        consecutive = 0;
      }
      if (consecutive >= 15) { console.log("  giving up"); break; }
      await new Promise(r => setTimeout(r, 2000 * consecutive));
      continue;
    }
    consecutive = 0;
    const row = (data && data[0]) || {};
    const next = row.last_id;
    const seen = row.n_updated ?? 0;
    if (!next) break;
    lastId = next;
    totalSeen += seen;
    if (pass % 20 === 0) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`  pass ${pass}: seen ${totalSeen.toLocaleString()} so far (chunk=${chunk}, ${elapsed}s)`);
    }
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`  DONE ${job.source}: scanned ${totalSeen.toLocaleString()} rows in ${pass} passes (${elapsed}s)`);
}

for (const job of JOBS) await runJob(job);
console.log("\nAll jobs done.");
