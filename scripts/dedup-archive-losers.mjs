/**
 * Soft-archives duplicate rows by setting `is_published=false` on every
 * row EXCEPT the most-recently-updated winner of each duplicate_audit
 * group. Re-runnable: rows already at is_published=false skip cheaply.
 *
 * Usage:
 *   node scripts/dedup-archive-losers.mjs                  # dry-run summary
 *   DEDUP_APPLY=true node scripts/dedup-archive-losers.mjs # archive all
 *   DEDUP_SOURCE=denue-mx-bulk DEDUP_APPLY=true ...        # limit to one
 */
import { createClient } from "@supabase/supabase-js";

const c = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);
const APPLY = process.env.DEDUP_APPLY === "true";
const SOURCE = process.env.DEDUP_SOURCE;

console.log(`DEDUP — ${APPLY ? "APPLY" : "DRY-RUN"}${SOURCE ? ` source=${SOURCE}` : ""}`);

const { data: summary, error: e1 } = await c
  .from("duplicate_audit_summary")
  .select("*")
  .order("extra_rows", { ascending: false });
if (e1) { console.error(e1); process.exit(1); }

let totalExtra = 0;
console.log("\nsource".padEnd(35) + "| groups |  extra");
for (const r of summary ?? []) {
  if (SOURCE && r.source !== SOURCE) continue;
  console.log(`${r.source.padEnd(34)} | ${String(r.dup_groups).padStart(6)} | ${String(r.extra_rows).padStart(6)}`);
  totalExtra += Number(r.extra_rows);
}
console.log(`\nTotal extra: ${totalExtra.toLocaleString()}`);

if (!APPLY) { console.log("\nDry-run. DEDUP_APPLY=true to archive."); process.exit(0); }

// Pull ALL archive_ids in one query per source, then UPDATE in id-chunks.
const sources = (summary ?? []).filter(r => !SOURCE || r.source === SOURCE);
for (const s of sources) {
  console.log(`\n=== ${s.source} (${s.extra_rows} extra) ===`);
  // Paginate the view to avoid 1000-row PostgREST cap
  const allArchiveIds = [];
  for (let from = 0; from < 200_000; from += 1000) {
    const { data, error } = await c
      .from("duplicate_audit")
      .select("archive_ids")
      .eq("source", s.source)
      .range(from, from + 999);
    if (error) { console.log(`  fetch ERROR ${error.message}`); break; }
    if (!data || data.length === 0) break;
    for (const g of data) allArchiveIds.push(...(g.archive_ids ?? []));
    if (data.length < 1000) break;
  }
  console.log(`  collected ${allArchiveIds.length} archive_ids`);
  if (allArchiveIds.length === 0) continue;

  // UPDATE in chunks of 500
  let done = 0;
  const t0 = Date.now();
  for (let i = 0; i < allArchiveIds.length; i += 500) {
    const ids = allArchiveIds.slice(i, i + 500);
    const { error } = await c
      .from("professionals")
      .update({ is_published: false })
      .in("id", ids)
      .eq("is_published", true);
    if (error) { console.log(`  chunk @${i} ERROR ${error.message}`); continue; }
    done += ids.length;
    if ((i / 500) % 10 === 0) console.log(`  @${i}: ${done}/${allArchiveIds.length} (${((Date.now()-t0)/1000).toFixed(0)}s)`);
  }
  console.log(`  DONE ${s.source}: ${done} archived`);
}
console.log("\nAll done.");
