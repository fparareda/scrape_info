import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { toTitleCase } from "./_bulk-utils.js";
import { fetchThentiaDirectory } from "./_thentia-utils.js";

/**
 * AMVIC — Alberta Motor Vehicle Industry Council.
 *
 * Public register at
 *   https://amvic.ca.thentiacloud.net/webs/amvic/register/
 * is hosted on Thentia Cloud (tenant: `amvic.ca`). Mixed roster of
 * dealers + repair shops + salespeople. We route every record to
 * `mecanica` (closest taxonomy match for auto trades); a small
 * heuristic re-routes obvious dealer/sales records to … still
 * `mecanica` since `concesionario` isn't in the enum. License kind
 * is preserved in metadata for downstream filtering.
 *
 * Off by default; `PROLIO_RUN_AMVIC_DEALERS=true`.
 */

const TENANT = "amvic.ca";
const DEFAULT_LIMIT = 5000;
const DEFAULT_CITY = "calgary";
const CATEGORY: CategoryKey = "mecanica";

const AB_CITY_MAP: Record<string, string> = {
  calgary: "calgary",
  edmonton: "edmonton",
};

function mapCity(raw: string | undefined): string {
  const k = (raw ?? "").toLowerCase().trim();
  return AB_CITY_MAP[k] ?? DEFAULT_CITY;
}

export const amvicDealersSource: ScraperSource = {
  name: "tssa" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_AMVIC_DEALERS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runAmvicDealers(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!amvicDealersSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const limit = Number(process.env.PROLIO_AMVIC_DEALERS_LIMIT ?? DEFAULT_LIMIT);
  const cap = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT;

  const records: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  for await (const rec of fetchThentiaDirectory(TENANT, { limit: cap })) {
    const num = rec.licenseNumber ?? `${rec.name}-${rec.city ?? ""}`;
    const key = `amvic:${num}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(
      normalise({
        source: "tssa" as ScrapeSource,
        sourceId: key,
        name: toTitleCase(rec.name),
        categoryKey: CATEGORY,
        citySlug: mapCity(rec.city),
        licenseNumber: rec.licenseNumber,
        address: rec.address,
        phone: rec.phone,
        email: rec.email,
        website: rec.website,
        metadata: {
          country: "CA",
          province: "AB",
          authority: "AMVIC",
          verified_by_authority: true,
          status: rec.status,
          license_kind: "motor-vehicle-industry",
        },
      }),
    );
  }
  if (records.length === 0) {
    console.warn("[amvic-dealers] no rows — Thentia endpoint may have changed");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[amvic-dealers] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
