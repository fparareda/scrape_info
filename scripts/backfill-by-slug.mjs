/**
 * Backfill city_country='MX' for denue-mx-bulk rows by iterating each
 * city_slug one statement at a time. Each per-slug UPDATE is small
 * enough to fit the 8s PostgREST cap; the previous JOIN-based loops
 * scanned too many NULL rows per pass.
 *
 * Loops top_null_slugs_for_source until 0 left.
 */
import { createClient } from "@supabase/supabase-js";

const c = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

let totalAll = 0;
let round = 0;
const t0 = Date.now();
while (true) {
  round++;
  const { data: slugs, error: errSlugs } = await c.rpc("top_null_slugs_for_source", {
    p_source: "denue-mx-bulk", p_limit: 100,
  });
  if (errSlugs) {
    console.log(`round ${round}: slug fetch ERROR ${errSlugs.message}`);
    await new Promise(r => setTimeout(r, 3000));
    continue;
  }
  if (!slugs || slugs.length === 0) {
    console.log(`\nNo more NULL slugs. Stopping.`);
    break;
  }
  console.log(`\n=== round ${round}: ${slugs.length} slugs to process ===`);

  let roundTotal = 0;
  for (let i = 0; i < slugs.length; i++) {
    const { slug, n } = slugs[i];
    const { error, count } = await c
      .from("professionals")
      .update({ city_country: "MX" }, { count: "exact" })
      .eq("source", "denue-mx-bulk")
      .eq("city_slug", slug)
      .is("city_country", null);
    if (error) {
      // FK violation = slug not in cities. Skip silently.
      if (error.code !== "23503") {
        console.log(`  ${slug}: ${error.message.slice(0, 60)}`);
      }
      continue;
    }
    roundTotal += count ?? 0;
    if (i % 20 === 0)
      console.log(`  [${i + 1}/${slugs.length}] ${slug}: +${count ?? 0} round=${roundTotal.toLocaleString()}`);
  }
  totalAll += roundTotal;
  console.log(`  round ${round} done: +${roundTotal.toLocaleString()} all=${totalAll.toLocaleString()} ${((Date.now()-t0)/1000).toFixed(0)}s`);
  if (roundTotal === 0) {
    console.log(`\nRound made no progress. Stopping (remaining slugs lack MX city rows).`);
    break;
  }
}
console.log(`\nDONE: ${totalAll.toLocaleString()} rows in ${round} rounds (${((Date.now()-t0)/1000).toFixed(1)}s)`);
