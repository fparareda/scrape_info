import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { toTitleCase } from "./_bulk-utils.js";
import { fetchAlinityDirectory } from "./_alinity-utils.js";

/**
 * College of Physiotherapists of Alberta (CPTA).
 *
 * Public "Verify a Physiotherapist" register at
 *   https://cpta.alinityapp.com/client/publicdirectory
 * hosted on Alinity (tenant: `cpta`). No captcha, no Cloudflare;
 * robots.txt allows all paths (Allow: /).
 *
 * Alberta has ~4,000 registered physiotherapists (General + Provisional
 * registers). The existing `_alinity-utils.ts` prefix-enumeration handles
 * the 25-row pagination cap automatically.
 *
 * Category: fisioterapia. Province: AB, country: CA.
 * Off by default; `PROLIO_RUN_CPTA_AB_PHYSIO=true` to enable.
 */

const TENANT = "cpta";
const AUTHORITY = "CPTA";
const PROVINCE = "AB";
const CATEGORY: CategoryKey = "fisioterapia";
const DEFAULT_CITY = "calgary";
const DEFAULT_LIMIT = 5_000;

const CITY_MAP: Record<string, string> = {
  calgary: "calgary",
  edmonton: "edmonton",
  "red deer": "red-deer",
  lethbridge: "lethbridge",
  "medicine hat": "medicine-hat",
  "grande prairie": "grande-prairie",
  airdrie: "airdrie",
  spruce: "spruce-grove",
  "fort mcmurray": "fort-mcmurray",
};

function mapCity(raw: string | undefined): string {
  const k = (raw ?? "").toLowerCase().trim();
  return CITY_MAP[k] ?? DEFAULT_CITY;
}

export const cptaAbPhysioSource: ScraperSource = {
  name: "cpta-ab-physio" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_CPTA_AB_PHYSIO === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCptaAbPhysio(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cptaAbPhysioSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const limit = Number(process.env.PROLIO_CPTA_AB_PHYSIO_LIMIT ?? DEFAULT_LIMIT);
  const cap = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT;

  const records: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  for await (const rec of fetchAlinityDirectory(TENANT, { limit: cap })) {
    const num = rec.registrationNumber ?? `${rec.name}-${rec.city ?? ""}`;
    const key = `cpta-ab-physio:${num}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(
      normalise({
        source: "cpta-ab-physio" as ScrapeSource,
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
    console.warn(`[cpta-ab-physio] no rows — Alinity endpoint may have changed`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[cpta-ab-physio] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
