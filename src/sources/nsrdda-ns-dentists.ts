import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { toTitleCase } from "./_bulk-utils.js";
import { fetchAlinityDirectory } from "./_alinity-utils.js";

/**
 * NSRDDA — Nova Scotia Regulator of Dentistry and Dental Assisting.
 *
 * Successor to the Provincial Dental Board of Nova Scotia (PDBNS), brought
 * under the Regulated Health Professions Act on 2025-05-01. The Alinity
 * tenant migrated from `pdbns` to `nsrdda` at that time.
 *
 * Public directory at:
 *   https://nsrdda.alinityapp.com/client/publicdirectory
 *
 * Pre-flight (2026-05-22):
 *
 *   robots.txt (nsrdda.ca): ALLOWS crawling. Only /wp-admin/ and one
 *     specific JSON file blocked. The alinityapp.com subdomain has no
 *     robots.txt that restricts the publicdirectory path.
 *
 *   Auth / CAPTCHA: None. Standard Alinity shell (same pattern as
 *     lsnb-bar, cap-psychologists, cpm-physio, cpsnl, cpspei, cpsm).
 *     Shell page embeds `<input id="querySID" value="<N>">` in server-
 *     rendered HTML. The _alinity-utils.ts helper extracts this at
 *     runtime and drives recursive 2..4-letter last-name prefix drill.
 *
 *   Record scope: dentists + registered dental assistants (RDAs) licensed
 *     in Nova Scotia. Expected ~1,100 dentists + ~2,000 RDAs = ~3,100
 *     total — well above the 500-record threshold.
 *
 *   Category: `dentista` (RDAs are mapped to the same category —
 *     closest taxonomy fit; metadata.profession distinguishes them).
 *
 *   City mapping: Prolio only seeds `halifax` as the NS city bucket.
 *     All NS records collapse to `halifax`; the raw city name (mcn
 *     field from Alinity) is preserved in metadata.city_raw.
 *
 *   Off by default. Enable via `PROLIO_RUN_NSRDDA_NS_DENTISTS=true`.
 *   Monthly cadence via scrape-nsrdda-ns-dentists.yml.
 */

const TENANT = "nsrdda";
const AUTHORITY = "NSRDDA";
const PROVINCE = "NS";
const CATEGORY: CategoryKey = "dentista";
const DEFAULT_CITY = "halifax";
const DEFAULT_LIMIT = 5000;

// Nova Scotia city slug map. Only Halifax is seeded in Prolio for NS;
// everything else falls back to halifax (province-wide regulator).
const NS_CITY_MAP: Record<string, string> = {
  halifax: "halifax",
  dartmouth: "halifax",
  bedford: "halifax",
  sackville: "halifax",
  // All other NS communities not seeded → halifax
};

function mapCity(raw: string | undefined): string {
  const k = (raw ?? "").toLowerCase().trim();
  return NS_CITY_MAP[k] ?? DEFAULT_CITY;
}

export const nsrddaNsDentistsSource: ScraperSource = {
  name: "nsrdda-ns-dentists" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_NSRDDA_NS_DENTISTS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runNsrddaNsDentists(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!nsrddaNsDentistsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const limit = Number(
    process.env.PROLIO_NSRDDA_NS_DENTISTS_LIMIT ?? DEFAULT_LIMIT,
  );
  const cap = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT;

  const records: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for await (const rec of fetchAlinityDirectory(TENANT, { limit: cap })) {
    const num =
      rec.registrationNumber ?? `${rec.name}-${rec.city ?? ""}`;
    const key = `nsrdda-ns-dentists:${num}`;
    if (seen.has(key)) continue;
    seen.add(key);

    records.push(
      normalise({
        source: "nsrdda-ns-dentists" as ScrapeSource,
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
          first_name: rec.firstName,
          last_name: rec.lastName,
        },
      }),
    );
  }

  if (records.length === 0) {
    console.warn(
      `[nsrdda-ns-dentists] no rows — Alinity endpoint may have changed`,
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[nsrdda-ns-dentists] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
