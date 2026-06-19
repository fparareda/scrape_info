/**
 * Cross-enrich Colombian companies by NIT.
 *
 *   npm run enrich-co-nit
 *
 * Calls public.enrich_co_by_nit(batch) in a loop until it stops upgrading:
 * a SECOP row (has phone/email/address, category 'empresa') whose NIT also
 * appears as a RUES row mapped to a profession vertical inherits that vertical.
 * Net effect: contactable SECOP listings land in the right category.
 * Free combination of the two open datasets' strengths
 * (docs/SCRAPING_CO_20260619.md §3).
 */

import { createClient } from "@supabase/supabase-js";

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error("[enrich-co-nit] missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  const client = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });
  const batch = Number(process.env.PROLIO_ENRICH_BATCH ?? 2000) || 2000;
  let total = 0;
  for (;;) {
    const { data, error } = await client.rpc("enrich_co_by_nit", { batch });
    if (error) {
      console.error("[enrich-co-nit] failed:", error.message);
      process.exit(1);
    }
    const n = Number(data ?? 0);
    total += n;
    console.log(`[enrich-co-nit] upgraded ${n} (total ${total})`);
    if (n === 0) break;
  }
  console.log(`[enrich-co-nit] done — total upgraded ${total}`);
}

main().catch((err) => {
  console.error("[enrich-co-nit] failed:", err);
  process.exit(1);
});
