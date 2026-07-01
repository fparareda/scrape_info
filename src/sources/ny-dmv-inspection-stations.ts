import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";

/**
 * New York State DMV — Facilities Licensed by the Department of Motor Vehicles.
 *
 * Same Socrata dataset as `ny-dmv-repair-shops.ts` (view ID: nhjr-rpi2) on
 * data.ny.gov, filtered to a different `business_type` slice:
 *   https://data.ny.gov/Transportation/Facilities-Licensed-by-the-DMV/nhjr-rpi2
 *
 * Filter: `business_type in ('ISP','ISD','ISF')` (Inspection Station —
 * Private / Dealer / Fleet) → ~10,955 rows (verified 2026-07-01):
 *   ISP (private inspection stations): 10,408
 *   ISD (dealer inspection stations):     326
 *   ISF (fleet inspection stations):      221
 *
 * These are the NYS-licensed vehicle safety/emissions inspection stations —
 * the US analogue of the `itv` (ITV / vehicle inspection) category used for
 * Spain's ITV network. No prior US source covers vehicle inspection
 * stations; `ny-dmv-repair-shops.ts` only pulls `business_type=RS` (auto
 * repair shops, mapped to `mecanica`) from this same dataset, so there is
 * no overlap between the two sources.
 *
 * Fields: facility_number (unique ID), facility_name, owner_name,
 *   street, city, state, zip, business_type,
 *   original_issuance_date, last_renewal_date, expiration_date.
 *
 * Pre-flight 2026-07-01:
 *   GET https://data.ny.gov/resource/nhjr-rpi2.json?$where=business_type in('ISP','ISD','ISF')&$limit=5000
 *     → 200 OK, plain JSON array, public domain (data.ny.gov Socrata).
 *   robots.txt (data.ny.gov): only `/api/odata/` and `/api/collocate*` are
 *     disallowed; `/resource/` is not mentioned — ALLOWED. Crawl-delay: 1.
 *   No login, no CAPTCHA, no Cloudflare/WAF challenge — plain JSON GET.
 *
 * Off by default. `PROLIO_RUN_NY_DMV_INSPECTION_STATIONS=true` to enable.
 * Cap with `PROLIO_NY_DMV_INSPECTION_STATIONS_LIMIT` (default 20000).
 */

const SODA_BASE =
  process.env.PROLIO_NY_DMV_INSPECTION_STATIONS_URL ??
  "https://data.ny.gov/resource/nhjr-rpi2.json";
const DEFAULT_LIMIT = 20_000;
const PAGE_SIZE = 5_000;
const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const CATEGORY: CategoryKey = "itv";
const SOURCE_NAME = "ny-dmv-inspection-stations" as ScrapeSource;
const INSPECTION_BUSINESS_TYPES = "'ISP','ISD','ISF'";

interface DmvRow {
  facility_number?: string;
  facility_name?: string;
  owner_name?: string;
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  business_type?: string;
  expiration_date?: string;
}

async function fetchPage(offset: number, limit: number): Promise<DmvRow[]> {
  const url = new URL(SODA_BASE);
  url.searchParams.set("$where", `business_type in(${INSPECTION_BUSINESS_TYPES})`);
  url.searchParams.set("$limit", String(Math.min(limit, PAGE_SIZE)));
  url.searchParams.set("$offset", String(offset));
  url.searchParams.set("$order", "facility_number");
  const response = await fetch(url, {
    headers: {
      "User-Agent": POLITE_UA,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`NY DMV Socrata HTTP ${response.status}`);
  }
  return (await response.json()) as DmvRow[];
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedNoId = 0;
  let droppedNoName = 0;
  let droppedNoCity = 0;
  let offset = 0;

  for (let page = 0; page < 20; page += 1) {
    const remaining = limit - out.length;
    if (remaining <= 0) break;

    let rows: DmvRow[];
    try {
      rows = await fetchPage(offset, remaining);
    } catch (error) {
      console.error(
        `[ny-dmv-inspection-stations] page offset=${offset} failed: ${(error as Error).message}`,
      );
      break;
    }
    if (rows.length === 0) break;

    for (const row of rows) {
      if (out.length >= limit) break;

      const facilityNum = (row.facility_number ?? "").trim();
      if (!facilityNum) {
        droppedNoId += 1;
        continue;
      }

      const name = (row.facility_name ?? row.owner_name ?? "").trim();
      if (!name) {
        droppedNoName += 1;
        continue;
      }

      const cityRaw = (row.city ?? "").trim();
      if (!cityRaw) {
        droppedNoCity += 1;
        continue;
      }

      const sourceId = `ny-dmv-inspection:${facilityNum}`;
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);

      const street = (row.street ?? "").trim();
      const zip = (row.zip ?? "").trim();
      const address =
        [street, cityRaw, "NY", zip].filter(Boolean).join(", ") || undefined;

      out.push(
        normalise({
          source: SOURCE_NAME,
          country: "US",
          sourceId,
          name,
          categoryKey: CATEGORY,
          citySlug: slugify(cityRaw),
          address,
          licenseNumber: facilityNum,
          metadata: {
            country: "US",
            state: "NY",
            authority: "New York State DMV",
            verified_by_authority: true,
            business_type: (row.business_type ?? "").trim() || undefined,
            owner_name: (row.owner_name ?? "").trim() || undefined,
            expiration_date: row.expiration_date ?? undefined,
          },
        }),
      );
    }

    if (rows.length < Math.min(PAGE_SIZE, remaining)) break;
    offset += rows.length;
  }

  console.log(
    `[ny-dmv-inspection-stations] parsed=${out.length} ` +
      `dropped_no_id=${droppedNoId} dropped_no_name=${droppedNoName} ` +
      `dropped_no_city=${droppedNoCity}`,
  );
  return out;
}

export const nyDmvInspectionStationsSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_NY_DMV_INSPECTION_STATIONS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runNyDmvInspectionStations(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!nyDmvInspectionStationsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(
    process.env.PROLIO_NY_DMV_INSPECTION_STATIONS_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[ny-dmv-inspection-stations] upserted=${records.length} ` +
      `inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
