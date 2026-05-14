import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { toTitleCase } from "./_bulk-utils.js";
import { fetchAlinityDirectory } from "./_alinity-utils.js";

/**
 * College of Physical Therapists of BC (CPTBC) — now operating as
 * "College of Health and Care Professionals of BC".
 *
 * Public directory:
 *   https://cptbc.alinityapp.com/client/publicdirectory
 *
 * Platform: Alinity (tenant `cptbc`). Pre-flight 2026-05-14:
 *   - querySID = 1000673
 *   - EnableCaptcha: false on all probed prefixes
 *   - Saturation threshold: 75 records per request (vs 25 for most tenants)
 *   - Record shape: {rg (GUID), rl ("Last, First"), ps (status), ef/ex (dates)}
 *   - City field (`hc`) = "hidden" — CPTBC does not publish practice location
 *     in the public register. All records default to `vancouver` (primary BC metro).
 *   - Estimated ~5,000–7,000 active+non-active registrants.
 *
 * Off by default; set `PROLIO_RUN_CPTBC_PHYSIO=true`.
 * Cap with `PROLIO_CPTBC_PHYSIO_LIMIT` (default 10000).
 */

const TENANT = "cptbc";
const AUTHORITY = "CPTBC";
const PROVINCE = "BC";
const CATEGORY: CategoryKey = "fisioterapia";
const DEFAULT_CITY = "vancouver";
const DEFAULT_LIMIT = 10_000;

// BC city slug map for any future city field exposure
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

  for await (const rec of fetchAlinityDirectory(TENANT, {
    limit: cap,
    // CPTBC saturates at 75 per prefix (not 25); the Alinity helper
    // uses SATURATED_THRESHOLD=25 internally and will drill deeper on
    // any prefix returning ≥25 rows, which is correct for this tenant.
  })) {
    // Use GUID as primary key; fall back to name+city composite.
    const id = rec.registrantGuid ?? `${rec.name}|${rec.city ?? ""}`;
    const key = `cptbc-physio:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(
      normalise({
        source: "cptbc-physio" as ScrapeSource,
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
