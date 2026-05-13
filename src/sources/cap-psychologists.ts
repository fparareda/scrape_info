import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { toTitleCase } from "./_bulk-utils.js";
import { fetchAlinityDirectory } from "./_alinity-utils.js";

/**
 * College of Alberta Psychologists.
 * Hosted on Alinity (tenant: `cap`). Off by default;
 * `PROLIO_RUN_CAP_PSYCHOLOGISTS=true` to enable.
 */

const TENANT = "cap";
const AUTHORITY = "CAP";
const PROVINCE = "AB";
const CATEGORY: CategoryKey = "psicologia";
const DEFAULT_CITY = "calgary";
const DEFAULT_LIMIT = 5000;
const CITY_MAP: Record<string, string> = {"calgary":"calgary","edmonton":"edmonton"};

function mapCity(raw: string | undefined): string {
  const k = (raw ?? "").toLowerCase().trim();
  return CITY_MAP[k] ?? DEFAULT_CITY;
}

export const capPsychologistsSource: ScraperSource = {
  name: "cap-psychologists" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_CAP_PSYCHOLOGISTS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCapPsychologists(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!capPsychologistsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const limit = Number(process.env.PROLIO_CAP_PSYCHOLOGISTS_LIMIT ?? DEFAULT_LIMIT);
  const cap = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT;

  const records: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  for await (const rec of fetchAlinityDirectory(TENANT, { limit: cap })) {
    const num = rec.registrationNumber ?? `${rec.name}-${rec.city ?? ""}`;
    const key = `cap-psychologists:${num}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(
      normalise({
        source: "cap-psychologists" as ScrapeSource,
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
    console.warn(`[cap-psychologists] no rows — Alinity endpoint may have changed`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[cap-psychologists] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
