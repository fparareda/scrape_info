import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { toTitleCase } from "./_bulk-utils.js";
import { fetchAlinityDirectory } from "./_alinity-utils.js";

/**
 * College of Physical Therapists of BC (CPTBC) — now operating as
 * "College of Health and Care Professionals of BC" (CHCPBC).
 *
 * Public directory:
 *   https://cptbc.alinityapp.com/client/publicdirectory
 *
 * Platform: Alinity (tenant `cptbc`). Pre-flight 2026-06-12:
 *   - robots.txt returns 404 (all paths allowed).
 *   - EnableCaptcha: false on probed prefixes.
 *   - Saturation threshold: 25 records per prefix (standard Alinity).
 *   - City field (`hc`) is hidden in the public register — CPTBC does
 *     not publish practice location. All records default to `vancouver`.
 *   - Estimated ~5,400 active + inactive registrants (CHCPBC 2024/25
 *     Annual Report).
 *
 * Off by default; set `PROLIO_RUN_CPTBC_PHYSIO=true`.
 * Cap with `PROLIO_CPTBC_PHYSIO_LIMIT` (default 10000).
 */

const TENANT = "cptbc";
const AUTHORITY = "CHCPBC";
const PROVINCE = "BC";
const CATEGORY: CategoryKey = "fisioterapia";
const DEFAULT_CITY = "vancouver";
const DEFAULT_LIMIT = 10_000;

const CITY_MAP: Record<string, string> = {
  vancouver: "vancouver",
  victoria: "victoria",
  burnaby: "burnaby",
  surrey: "surrey",
  kelowna: "kelowna",
  abbotsford: "abbotsford",
  "north vancouver": "vancouver",
  richmond: "vancouver",
  "west vancouver": "vancouver",
  coquitlam: "vancouver",
  langley: "vancouver",
};

function mapCity(raw: string | undefined): string {
  const k = (raw ?? "").toLowerCase().trim();
  return CITY_MAP[k] ?? DEFAULT_CITY;
}

export const cptbcPhysioSource: ScraperSource = {
  name: "cptbc-physio" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_CPTBC_PHYSIO === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCptbcPhysio(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cptbcPhysioSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const limit = Number(process.env.PROLIO_CPTBC_PHYSIO_LIMIT ?? DEFAULT_LIMIT);
  const cap = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT;

  const records: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for await (const rec of fetchAlinityDirectory(TENANT, { limit: cap })) {
    const id = rec.registrantGuid ?? `${rec.name}|${rec.city ?? ""}`;
    const key = `cptbc-physio:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(
      normalise({
        source: "cptbc-physio" as ScrapeSource,
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
          registrant_guid: rec.registrantGuid,
        },
      }),
    );
  }

  if (records.length === 0) {
    console.warn("[cptbc-physio] no rows — Alinity endpoint may have changed");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[cptbc-physio] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
