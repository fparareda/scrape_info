/**
 * Promote stored cities to the display whitelist by professional-count.
 *
 *   npm run promote-cities
 *
 * Calls the public.promote_cities(min_count) SQL function (migration
 * 20260619000004): any (country, city_slug) with >= min_count professionals
 * that isn't already whitelisted gets a city_whitelist row (reason
 * 'promotion'). Threshold via PROLIO_PROMOTE_MIN_COUNT (default 50).
 *
 * Storage stays a superset; this is the only path (besides the seed) that
 * makes a city visible on the web. See docs/SCRAPING_CO_20260619.md §1b.
 */

import { createClient } from "@supabase/supabase-js";

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error(
      "[promote-cities] missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
    );
    process.exit(1);
  }
  const minCount = Number(process.env.PROLIO_PROMOTE_MIN_COUNT ?? 50);
  const client = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });
  const { data, error } = await client.rpc("promote_cities", {
    min_count: Number.isFinite(minCount) && minCount > 0 ? minCount : 50,
  });
  if (error) {
    console.error("[promote-cities] failed:", error.message);
    process.exit(1);
  }
  console.log(
    `[promote-cities] promoted ${data ?? 0} cities (threshold=${minCount})`,
  );
}

main().catch((err) => {
  console.error("[promote-cities] failed:", err);
  process.exit(1);
});
