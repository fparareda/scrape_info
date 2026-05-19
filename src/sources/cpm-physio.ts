import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { toTitleCase } from "./_bulk-utils.js";
import { fetchAlinityDirectory } from "./_alinity-utils.js";

/**
 * College of Physiotherapists of Manitoba.
 * Hosted on Alinity (tenant: `cpm`). Off by default;
 * `PROLIO_RUN_CPM_PHYSIO=true` to enable.
 */

const TENANT = "cpm";
const AUTHORITY = "CPM";
const PROVINCE = "MB";
const CATEGORY: CategoryKey = "fisioterapia";
const DEFAULT_CITY = "winnipeg";
const DEFAULT_LIMIT = 5000;
const CITY_MAP: Record<string, string> = {"winnipeg":"winnipeg"};

function mapCity(raw: string | undefined): string {
  const k = (raw ?? "").toLowerCase().trim();
  return CITY_MAP[k] ?? DEFAULT_CITY;
}

export const cpmPhysioSource: ScraperSource = {
  name: "cpm-physio" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_CPM_PHYSIO === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCpmPhysio(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cpmPhysioSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const limit = Number(process.env.PROLIO_CPM_PHYSIO_LIMIT ?? DEFAULT_LIMIT);
  const cap = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT;

  const records: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  for await (const rec of fetchAlinityDirectory(TENANT, { limit: cap })) {
    const num = rec.registrationNumber ?? `${rec.name}-${rec.city ?? ""}`;
    const key = `cpm-physio:${num}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(
      normalise({
        source: "cpm-physio" as ScrapeSource,
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
          registration_date: rec.registrationDate,
        },
      }),
    );
  }
  if (records.length === 0) {
    console.warn(`[cpm-physio] no rows — Alinity endpoint may have changed`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[cpm-physio] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
