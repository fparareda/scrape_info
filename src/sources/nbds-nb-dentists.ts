import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { toTitleCase } from "./_bulk-utils.js";
import { fetchAlinityDirectory } from "./_alinity-utils.js";

/**
 * NBDS — New Brunswick Dental Society (Société dentaire du Nouveau-Brunswick).
 *
 * Public directory at
 *   https://nbds.alinityapp.com/client/PublicDirectory
 * (Alinity tenant `nbds`).
 *
 * The register lists practicing dentists and dental assistants regulated
 * by the NBDS under the New Brunswick Dental Act. We keep all registrants
 * under the `dentista` category.
 *
 * robots.txt (2026-06-24): The Alinity subdomain returns 404 on robots.txt —
 * standard Alinity behaviour; the parent domain (nbdent.ca) only disallows
 * `/wp-admin/`. The public directory at `nbds.alinityapp.com` has no
 * authentication, no Cloudflare wall, and no CAPTCHA.
 *
 * Pre-flight 2026-06-24 (datacenter IP):
 *   https://nbds.alinityapp.com/client/PublicDirectory → 200
 *   querySID discoverable from the shell HTML. No login required.
 *   Existing `_alinity-utils` helper handles tenant search + prefix recursion.
 *
 * Record count estimate: ~385 licensed dentists in NB (NB population ~810k,
 * population-to-dentist ratio ~1:2100; CIHI data). Small province — reasonable
 * for Atlantic Canada coverage.
 *
 * City mapping: NB Alinity records expose `mcn` (practice city). Main NB
 * cities mapped to slugs; unknown cities fall back to `moncton` (largest city).
 *
 * Off by default — `PROLIO_RUN_NBDS_NB_DENTISTS=true` to enable.
 * Cap via `PROLIO_NBDS_NB_DENTISTS_LIMIT` (default 2_000).
 */

const TENANT = "nbds";
const AUTHORITY = "NBDS";
const PROVINCE = "NB";
const CATEGORY: CategoryKey = "dentista";
const DEFAULT_CITY = "moncton";
const DEFAULT_LIMIT = 2_000;

/**
 * New Brunswick city name → Prolio city slug.
 * Covers all major NB cities where dental professionals are expected.
 */
const NB_CITIES: Record<string, string> = {
  moncton: "moncton",
  fredericton: "fredericton",
  "saint john": "saint-john",
  "st. john": "saint-john",
  "st john": "saint-john",
  dieppe: "moncton",
  riverview: "moncton",
  miramichi: "miramichi",
  edmundston: "edmundston",
  bathurst: "bathurst",
  campbellton: "campbellton",
  "grand falls": "grand-falls",
  "grand-falls": "grand-falls",
  sackville: "sackville",
  sussex: "sussex",
  woodstock: "woodstock",
  oromocto: "fredericton",
  quispamsis: "saint-john",
  rothesay: "saint-john",
  "grand bay": "saint-john",
  "grand bay-westfield": "saint-john",
  tracadie: "tracadie",
  shippagan: "shippagan",
  caraquet: "caraquet",
};

function mapCity(raw: string | undefined): string {
  const k = (raw ?? "").toLowerCase().trim();
  if (!k) return DEFAULT_CITY;
  if (NB_CITIES[k]) return NB_CITIES[k];
  // Partial match
  for (const [key, slug] of Object.entries(NB_CITIES)) {
    if (k.startsWith(key) || key.startsWith(k)) return slug;
  }
  return DEFAULT_CITY;
}

export const nbdsNbDentistsSource: ScraperSource = {
  name: "nbds-nb-dentists" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_NBDS_NB_DENTISTS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runNbdsNbDentists(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!nbdsNbDentistsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(
    process.env.PROLIO_NBDS_NB_DENTISTS_LIMIT ?? DEFAULT_LIMIT,
  );
  const cap =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const records: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for await (const rec of fetchAlinityDirectory(TENANT, {
    limit: cap * 2,
    requestDelayMs: 500,
  })) {
    if (records.length >= cap) break;
    const num = rec.registrationNumber ?? `${rec.name}-${rec.city ?? ""}`;
    const key = `nbds:${num}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(
      normalise({
        source: "nbds-nb-dentists" as ScrapeSource,
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
          registration_class: rec.status,
          practice_city_raw: rec.city ?? null,
        },
      }),
    );
  }

  if (records.length === 0) {
    console.warn(
      `[nbds-nb-dentists] no rows — Alinity endpoint may have changed`,
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[nbds-nb-dentists] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
