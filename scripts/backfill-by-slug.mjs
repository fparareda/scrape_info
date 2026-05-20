/**
 * Backfill city_country for denue-mx-bulk by iterating each slug one
 * statement at a time. Per-slug UPDATEs are O(rows-per-slug) which fits
 * the 8s PostgREST cap, while the previous EXISTS-based loop kept
 * timing out because each call scanned thousands of NULL rows.
 */
import { createClient } from "@supabase/supabase-js";

const c = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

async function topSlugs() {
  // Page through duplicate_audit-style aggregation via direct SQL? Not
  // possible from PostgREST. Instead, ask DB for top N NULL slugs.
  const { data, error } = await c.rpc("top_null_slugs_for_source", {
    p_source: "denue-mx-bulk",
    p_limit: 500,
  });
  if (error) { console.error(error); process.exit(1); }
  return data ?? [];
}

const slugs = await topSlugs();
console.log(`Got ${slugs.length} slugs to process`);

let total = 0;
const t0 = Date.now();
for (let i = 0; i < slugs.length; i++) {
  const { slug, n } = slugs[i];
  const { error } = await c
    .from("professionals")
    .update({ city_country: "MX" })
    .eq("source", "denue-mx-bulk")
    .eq("city_slug", slug)
    .is("city_country", null);
  if (error) {
    console.log(`  ${slug} (${n}): ERROR ${error.message}`);
    await new Promise(r => setTimeout(r, 2000));
    continue;
  }
  total += Number(n);
  if (i % 20 === 0)
    console.log(`  [${i}/${slugs.length}] ${slug} (+${n}) total=${total.toLocaleString()} ${((Date.now()-t0)/1000).toFixed(0)}s`);
}
console.log(`DONE: ~${total.toLocaleString()} rows in ${slugs.length} slugs (${((Date.now()-t0)/1000).toFixed(1)}s)`);
