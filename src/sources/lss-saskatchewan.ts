import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { toTitleCase } from "./_bulk-utils.js";
import { fetchAlinityDirectory } from "./_alinity-utils.js";

/**
 * Law Society of Saskatchewan.
 * Hosted on Alinity (tenant: `lss`). Off by default;
 * `PROLIO_RUN_LSS_SASKATCHEWAN=true` to enable.
 */

const TENANT = "lss";
const AUTHORITY = "LSS";
const PROVINCE = "SK";
const CATEGORY: CategoryKey = "extranjeria";
const DEFAULT_CITY = "saskatoon";
const DEFAULT_LIMIT = 5000;
const CITY_MAP: Record<string, string> = {"saskatoon":"saskatoon","regina":"saskatoon"};

function mapCity(raw: string | undefined): string {
  const k = (raw ?? "").toLowerCase().trim();
  return CITY_MAP[k] ?? DEFAULT_CITY;
}

export const lssSaskatchewanSource: ScraperSource = {
  name: "cpsbc" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_LSS_SASKATCHEWAN === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runLssSaskatchewan(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!lssSaskatchewanSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const limit = Number(process.env.PROLIO_LSS_SASKATCHEWAN_LIMIT ?? DEFAULT_LIMIT);
  const cap = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT;

  const records: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  for await (const rec of fetchAlinityDirectory(TENANT, { limit: cap })) {
    const num = rec.registrationNumber ?? `${rec.name}-${rec.city ?? ""}`;
    const key = `lss-saskatchewan:${num}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(
      normalise({
        source: "cpsbc" as ScrapeSource,
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
    console.warn(`[lss-saskatchewan] no rows — Alinity endpoint may have changed`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[lss-saskatchewan] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
