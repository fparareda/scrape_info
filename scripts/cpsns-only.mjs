import { createClient } from "@supabase/supabase-js";
const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const Z = "00000000-0000-0000-0000-000000000000";
let last = Z, pass = 0, seen = 0, errs = 0;
while (true) {
  pass++;
  const { data, error } = await c.rpc("regeocode_v2", { p_source: "cpsns-ns-physicians", p_country: "CA", p_meta_key: "practice_location", p_after_id: last, chunk_size: 200 });
  if (error) { errs++; if (errs > 30) { console.log("BAIL"); break; } await new Promise(r=>setTimeout(r,3000)); continue; }
  errs = 0;
  if (!data || !data[0] || !data[0].last_id) break;
  last = data[0].last_id;
  seen += data[0].n_updated || 0;
  if (pass % 10 === 0) console.log(`pass ${pass}: seen ${seen}`);
}
console.log(`DONE: ${seen} rows in ${pass} passes`);
