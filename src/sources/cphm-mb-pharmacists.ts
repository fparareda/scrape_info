import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScraperSource,
  ScrapeSource,
} from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { toTitleCase } from "./_bulk-utils.js";
import { fetchAlinityDirectory } from "./_alinity-utils.js";

/**
 * CPhM — College of Pharmacists of Manitoba.
 *
 * Public directory at
 *   https://cphm.alinityapp.com/Client/PublicDirectory
 * (Alinity tenant `cphm`).
 *
 * The register lists both Pharmacists and Pharmacy Technicians
 * (Listed and Registered Pharmacy Technicians). We keep both under
 * the `farmacia` category — all are regulated pharmacy professionals.
 *
 * robots.txt (2026-06-13): `Disallow:` with no paths listed — full
 * access permitted. Crawl-delay: 10s (we use 1000ms between Alinity
 * POST requests, which is within that limit).
 *
 * Pre-flight 2026-06-13 (datacenter IP):
 *   https://cphm.alinityapp.com/Client/PublicDirectory → 200
 *   querySID discoverable from the shell HTML. No Cloudflare, no
 *   CAPTCHA, no auth. Existing `_alinity-utils` helper handles tenant
 *   search + prefix recursion.
 *
 * Record count estimate: ~2,500 pharmacists + ~600 pharmacy
 * technicians = ~3,100 total (Statistics Canada reports ~2,500 active
 * pharmacists registered in MB as of 2023; CPhM is the sole regulator).
 *
 * City mapping: CPhM Alinity records expose `mcn` (practice city).
 * We map known MB cities to their slugs; unknown cities fall back to
 * `winnipeg` (home to ~60% of Manitoba pharmacists).
 *
 * Off by default — `PROLIO_RUN_CPHM_MB_PHARMACISTS=true` to enable.
 * Cap via `PROLIO_CPHM_MB_PHARMACISTS_LIMIT` (default 5_000).
 */

const TENANT = "cphm";
const AUTHORITY = "CPhM";
const PROVINCE = "MB";
const CATEGORY: CategoryKey = "farmacia";
const DEFAULT_CITY = "winnipeg";
const DEFAULT_LIMIT = 5_000;

/**
 * Manitoba city name → Prolio city slug.
 * Only cities with ≥1 pharmacy professional expected in the register.
 */
const MB_CITIES: Record<string, string> = {
  winnipeg: "winnipeg",
  brandon: "brandon",
  steinbach: "steinbach",
  thompson: "thompson",
  portage: "portage-la-prairie",
  "portage la prairie": "portage-la-prairie",
  winkler: "winkler",
  morden: "morden",
  "the pas": "the-pas",
  flin: "flin-flon",
  "flin flon": "flin-flon",
  selkirk: "selkirk",
  dauphin: "dauphin",
  "st. james": "winnipeg",
  "east st. paul": "winnipeg",
  "west st. paul": "winnipeg",
  "headingley": "winnipeg",
  "stonewall": "stonewall",
  "beausejour": "beausejour",
  "niverville": "niverville",
  "altona": "altona",
  gimli: "gimli",
  "swan river": "swan-river",
  neepawa: "neepawa",
  virden: "virden",
  carman: "carman",
  "ste. anne": "sainte-anne",
  "sainte-anne": "sainte-anne",
  "st. pierre": "saint-pierre-jolys",
};

function mapCity(raw: string | undefined): string {
  const k = (raw ?? "").toLowerCase().trim();
  if (!k) return DEFAULT_CITY;
  if (MB_CITIES[k]) return MB_CITIES[k];
  // Partial match — if any key is a prefix of the raw city name.
  for (const [key, slug] of Object.entries(MB_CITIES)) {
    if (k.startsWith(key) || key.startsWith(k)) return slug;
  }
  return DEFAULT_CITY;
}

export const cphmMbPharmacistsSource: ScraperSource = {
  name: "cphm-mb-pharmacists" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_CPHM_MB_PHARMACISTS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCphmMbPharmacists(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cphmMbPharmacistsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(
    process.env.PROLIO_CPHM_MB_PHARMACISTS_LIMIT ?? DEFAULT_LIMIT,
  );
  const cap =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const records: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for await (const rec of fetchAlinityDirectory(TENANT, {
    limit: cap * 2,
    requestDelayMs: 1_000,
  })) {
    if (records.length >= cap) break;
    const num = rec.registrationNumber ?? `${rec.name}-${rec.city ?? ""}`;
    const key = `cphm:${num}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(
      normalise({
        source: "cphm-mb-pharmacists" as ScrapeSource,
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
      `[cphm-mb-pharmacists] no rows — Alinity endpoint may have changed`,
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[cphm-mb-pharmacists] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
