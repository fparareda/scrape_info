import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { toTitleCase } from "./_bulk-utils.js";
import { fetchAlinityDirectory } from "./_alinity-utils.js";

/**
 * CPSNB — College of Physicians and Surgeons of New Brunswick.
 *
 * Hosted on Alinity (tenant: `cpsnb`).  The public directory at
 * https://cpsnb.alinityapp.com/client/publicdirectory exposes a JSON
 * search API (same POST/Registrants endpoint used by cpsm, cpsnl,
 * cpspei, lsnb-bar).  Pre-flight 2026-05-30:
 *
 *   - robots.txt (cpsnb.org): blocks only Joomla system paths
 *     (/administrator/, /cache/, /tmp/, /libraries/);
 *     alinityapp.com sub-tenant has no robots.txt.
 *   - querySID: 1000608 (hard-coded as override; shell-discovery
 *     used as fallback in case the tenant rotates it).
 *   - EnableCaptcha: false — no CAPTCHA on any prefix query.
 *   - Record shape: `rl` = "Last, First (rn)" — handled by
 *     _alinity-utils.ts toAlinityRecord().
 *   - Estimated records: ~2,500–3,500 active licensed physicians.
 *
 * NB city coverage: Fredericton, Moncton, and Saint John are the
 * three major NB cities.  They are not currently seeded in
 * public.cities (same gap as lsnb-bar, which defaults to `halifax`).
 * All rows fall back to `halifax` with metadata.province=`NB` so the
 * provenance is preserved and rows can be re-bucketed once NB cities
 * are seeded.
 *
 * Category: `medicina` (licensed physicians).
 * Off by default; `PROLIO_RUN_CPSNB_NB_PHYSICIANS=true` to enable.
 * Monthly cron: .github/workflows/scrape-cpsnb-nb-physicians.yml.
 */

const TENANT = "cpsnb";
const QUERY_SID_OVERRIDE = "1000608";
const AUTHORITY = "CPSNB";
const PROVINCE = "NB";
const CATEGORY: CategoryKey = "medicina";
const DEFAULT_CITY = "halifax";
const DEFAULT_LIMIT = 5000;

function mapCity(raw: string | undefined): string {
  const k = (raw ?? "").toLowerCase().trim();
  if (k === "fredericton") return DEFAULT_CITY;
  if (k === "moncton") return DEFAULT_CITY;
  if (k === "saint john" || k === "saint-john") return DEFAULT_CITY;
  if (k === "dieppe") return DEFAULT_CITY;
  if (k === "riverview") return DEFAULT_CITY;
  return DEFAULT_CITY;
}

export const cpsnbNbPhysiciansSource: ScraperSource = {
  name: "cpsnb-nb-physicians" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_CPSNB_NB_PHYSICIANS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCpsnbNbPhysicians(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cpsnbNbPhysiciansSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const limit = Number(
    process.env.PROLIO_CPSNB_NB_PHYSICIANS_LIMIT ?? DEFAULT_LIMIT,
  );
  const cap = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT;

  const records: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  for await (const rec of fetchAlinityDirectory(TENANT, {
    limit: cap,
    querySID: QUERY_SID_OVERRIDE,
  })) {
    const num =
      rec.registrationNumber ?? `${rec.name}-${rec.city ?? ""}`;
    const key = `cpsnb-nb-physicians:${num}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(
      normalise({
        source: "cpsnb-nb-physicians" as ScrapeSource,
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
          status: rec.status,
          city_raw: rec.city,
        },
      }),
    );
  }
  if (records.length === 0) {
    console.warn(
      `[cpsnb-nb-physicians] no rows — Alinity endpoint may have changed`,
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[cpsnb-nb-physicians] done — fetched=${records.length} ` +
      `inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
