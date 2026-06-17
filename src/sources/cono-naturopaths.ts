import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScraperSource,
  ScrapeSource,
} from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { toTitleCase } from "./_bulk-utils.js";
import { fetchAlinityDirectory } from "./_alinity-utils.js";

/**
 * CONO — College of Naturopaths of Ontario.
 *
 * Public member directory at
 *   https://cono.alinityapp.com/client/publicdirectory
 * (Alinity tenant `cono`, querySID=1000457 as of 2026-05-27).
 *
 * The register exposes registered naturopathic doctors in Ontario with
 * registration class and standing. Records use the `rl` format
 * ("Last, First (registrationNumber)") which `_alinity-utils` already
 * handles — no fn/ln present in CONO's raw rows.
 *
 * Pre-flight 2026-05-27 (datacenter IP):
 *   GET https://cono.alinityapp.com/client/publicdirectory → 200 in ~1s,
 *   querySID=1000457 confirmed, no Cloudflare, no CAPTCHA. POST search
 *   returns Records for 2-letter prefixes (e.g. "ba"→20, "sm"→13).
 *   Estimated universe: ~1,000 – 1,500 registered NDs.
 *
 * robots.txt: alinityapp.com returns 404 — no restrictions.
 *
 * Category: `medicina` (naturopathic doctors — closest available key).
 * Off by default — `PROLIO_RUN_CONO_NATUROPATHS=true` to enable.
 * Cap via `PROLIO_CONO_NATUROPATHS_LIMIT` (default 5_000 — comfortably
 * above the full roster of ~1,500).
 */

const TENANT = "cono";
const AUTHORITY = "CONO";
const PROVINCE = "ON";
const CATEGORY: CategoryKey = "medicina";
const DEFAULT_CITY = "toronto"; // largest ON city; directory is province-wide
const DEFAULT_LIMIT = 5_000;

// Map a few prominent ON cities in case `city` field is populated.
const ON_CITY_MAP: Record<string, string> = {
  toronto: "toronto",
  ottawa: "ottawa",
  mississauga: "toronto",
  brampton: "toronto",
  hamilton: "hamilton",
  london: "london",
  kitchener: "toronto",
  waterloo: "toronto",
  windsor: "windsor",
  kingston: "toronto",
  sudbury: "toronto",
  "thunder bay": "toronto",
  barrie: "toronto",
};

function mapCity(raw: string | undefined): string {
  const k = (raw ?? "").toLowerCase().trim();
  return ON_CITY_MAP[k] ?? DEFAULT_CITY;
}

export const conoNaturopathsSource: ScraperSource = {
  name: "cono-naturopaths" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_CONO_NATUROPATHS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runConoNaturopaths(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!conoNaturopathsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(process.env.PROLIO_CONO_NATUROPATHS_LIMIT ?? DEFAULT_LIMIT);
  const cap =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const records: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for await (const rec of fetchAlinityDirectory(TENANT, { limit: cap * 2 })) {
    if (records.length >= cap) break;
    const num =
      rec.registrationNumber ?? `${rec.name}|${rec.city ?? ""}`;
    const key = `cono:${num}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(
      normalise({
        source: "cono-naturopaths" as ScrapeSource,
        country: "CA",
        sourceId: key,
        name: toTitleCase(rec.name),
        categoryKey: CATEGORY,
        citySlug: mapCity(rec.city),
        licenseNumber: rec.registrationNumber,
        metadata: {
          country: "CA",
          province: PROVINCE,
          authority: AUTHORITY,
          verified_by_authority: true,
          registration_class: rec.status ?? null,
          practice_city_raw: rec.city ?? null,
        },
      }),
    );
  }

  if (records.length === 0) {
    console.warn(
      `[cono-naturopaths] no rows yielded — Alinity endpoint may have changed`,
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[cono-naturopaths] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
