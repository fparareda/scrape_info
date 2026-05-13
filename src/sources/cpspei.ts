import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { toTitleCase } from "./_bulk-utils.js";
import { fetchAlinityDirectory } from "./_alinity-utils.js";

/**
 * College of Physicians and Surgeons of Prince Edward Island.
 * Hosted on Alinity (tenant: `cpspei`). Off by default;
 * `PROLIO_RUN_CPSPEI=true` to enable.
 */

const TENANT = "cpspei";
const AUTHORITY = "CPSPEI";
const PROVINCE = "PEI";
const CATEGORY: CategoryKey = "medicina";
const DEFAULT_CITY = "halifax";
const DEFAULT_LIMIT = 5000;
const CITY_MAP: Record<string, string> = {};

function mapCity(raw: string | undefined): string {
  const k = (raw ?? "").toLowerCase().trim();
  return CITY_MAP[k] ?? DEFAULT_CITY;
}

export const cpspeiSource: ScraperSource = {
  name: "cpspei" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_CPSPEI === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCpspei(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cpspeiSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const limit = Number(process.env.PROLIO_CPSPEI_LIMIT ?? DEFAULT_LIMIT);
  const cap = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT;

  const records: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  for await (const rec of fetchAlinityDirectory(TENANT, { limit: cap })) {
    const num = rec.registrationNumber ?? `${rec.name}-${rec.city ?? ""}`;
    const key = `cpspei:${num}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(
      normalise({
        source: "cpspei" as ScrapeSource,
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
    console.warn(`[cpspei] no rows — Alinity endpoint may have changed`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[cpspei] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
