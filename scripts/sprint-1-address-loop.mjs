import { createClient } from "@supabase/supabase-js";
const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const Z = "00000000-0000-0000-0000-000000000000";

const JOBS = [
  { fn: "regeocode_datos_gob_es_v2", label: "datos-gob-es" },
  { fn: "regeocode_rcdso_v2",        label: "rcdso" },
  { fn: "regeocode_oaq_v2",          label: "oaq" },
];

async function run(job) {
  console.log(`\n=== ${job.label} ===`);
  let chunk = 500, last = Z, pass = 0, seen = 0, errs = 0;
  const t0 = Date.now();
  while (true) {
    pass++;
    const { data, error } = await c.rpc(job.fn, { p_after_id: last, chunk_size: chunk });
    if (error) {
      errs++;
      console.log(`  pass ${pass}: ERROR ${error.message} (chunk=${chunk})`);
      if (errs >= 3 && chunk > 50) { chunk = Math.max(50, Math.floor(chunk/2)); console.log(`    -> shrunk to ${chunk}`); errs = 0; }
      if (errs >= 15) { console.log("  giving up"); break; }
      await new Promise(r => setTimeout(r, 2000 * errs));
      continue;
    }
    errs = 0;
    const row = (data && data[0]) || {};
    if (!row.last_id) break;
    last = row.last_id;
    seen += row.n_seen || 0;
    if (pass % 10 === 0) console.log(`  pass ${pass}: ${seen} (${((Date.now()-t0)/1000).toFixed(0)}s)`);
  }
  console.log(`  DONE ${job.label}: ${seen} in ${pass} passes (${((Date.now()-t0)/1000).toFixed(1)}s)`);
}

for (const j of JOBS) await run(j);
console.log("\nAll address jobs done.");
