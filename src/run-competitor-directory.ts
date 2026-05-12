/**
 * Competitor-directory runner. Fires from index.ts when
 * PROLIO_RUN_COMPETITOR_SCRAPER=true.
 *
 * Envs:
 *   - PROLIO_COMPETITOR_SCRAPER_LIMIT=<n>   (default 500 pages total)
 *   - PROLIO_COMPETITOR_SCRAPER_ADAPTERS=<a,b>  (default all)
 */

import { createClient } from "@supabase/supabase-js";
import { runCompetitorDirectoryScraper } from "./sources/competitor-directory.js";
import { sendScraperAlert } from "./alerts.js";

type Adapter = "tumejorelectricista" | "electricistaya";

function parseAdapters(raw: string | undefined): Adapter[] | undefined {
  if (!raw) return undefined;
  const allowed: Adapter[] = ["tumejorelectricista", "electricistaya"];
  const picks = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is Adapter => allowed.includes(s as Adapter));
  return picks.length ? picks : undefined;
}

function parseLimit(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Competitor scraper needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY",
    );
  }
  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const limit = parseLimit(process.env.PROLIO_COMPETITOR_SCRAPER_LIMIT);
  const adapters = parseAdapters(process.env.PROLIO_COMPETITOR_SCRAPER_ADAPTERS);

  const result = await runCompetitorDirectoryScraper(db, { limit, adapters });

  if (result.upserted > 0 || result.fetched > 0) {
    await sendScraperAlert(
      "high",
      `🕷️ Competitor scraper — ${result.upserted} nuevos pros`,
      `Fetched ${result.fetched} · upserted ${result.upserted} · with email ${result.withEmail} · with phone ${result.withPhone} · failures ${result.failures}`,
      "competitors",
    );
  }
}
