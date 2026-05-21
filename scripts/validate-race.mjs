/**
 * Tight loop: backfill any straggler NULLs then immediately try
 * VALIDATE CONSTRAINT. Wins the race when the validate scan starts
 * between worker INSERT cycles.
 */
import { createClient } from "@supabase/supabase-js";
const c = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

for (let i = 0; i < 30; i++) {
  await c.rpc("backfill_city_country_chunks", { chunk_size: 5000 });
  await c.rpc("reverse_geocode_chunk", { chunk_size: 500 });
  const { error } = await c.rpc("validate_constraint_now");
  if (!error) { console.log(`SUCCESS on attempt ${i + 1}`); process.exit(0); }
  console.log(`attempt ${i + 1}: ${error.message.slice(0, 80)}`);
  await new Promise(r => setTimeout(r, 500));
}
console.log("Gave up after 30 attempts.");
