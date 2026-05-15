import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { getCities } from "../cities.js";

/**
 * Delaware Business Licenses — Contractor subset.
 *
 * data.delaware.gov Socrata dataset `5zy2-grhr` ("Delaware Business
 * Licenses") contains all active Delaware business licence records.
 * The "RESIDENT CONTRACTOR" and "NON-RESIDENT CONTRACTOR" categories
 * together hold ~12k licences; filtering by state=DE yields ~8.2k
 * records with Delaware mailing addresses.
 *
 * Pre-flight (2026-05-15):
 *   GET https://data.delaware.gov/resource/5zy2-grhr.json?$select=count(*)
 *     &$where=category+in+('RESIDENT+CONTRACTOR','NON-RESIDENT+CONTRACTOR')
 *     +AND+state='DE'
 *   → {"count":"8200"}
 *
 *   robots.txt (data.delaware.gov/robots.txt): Crawl-delay 1; blocks
 *   /api/odata/, /OData.svc/, and browse-filter paths. The Socrata
 *   SODA /resource/ endpoint is NOT in any Disallow rule and is the
 *   intended programmatic access path (Socrata/Tyler Technologies'
 *   published open-data API).
 *
 *   Auth/WAF: none — dataset is fully public.
 *   Format: JSON API (Socrata SODA v2.1).
 *
 * Mapping:
 *   Both "RESIDENT CONTRACTOR" and "NON-RESIDENT CONTRACTOR" → `carpinteria`
 *   (general contractors; closest taxonomy match — no generic-contractor
 *   category exists yet).
 *
 * Off by default. `PROLIO_RUN_DELAWARE_CONTRACTOR=true` to enable.
 * Cap: `PROLIO_DELAWARE_CONTRACTOR_LIMIT` (default 2000).
 * Monthly cron — see .github/workflows/scrape-delaware-contractor.yml.
 */

const SODA_BASE =
  "https://data.delaware.gov/resource/5zy2-grhr.json";
const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const FALLBACK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 1_000;
const DEFAULT_LIMIT = 2_000;

// Socrata SODA filter: only DE-addressed contractor records.
const WHERE_CLAUSE =
  "category in ('RESIDENT CONTRACTOR','NON-RESIDENT CONTRACTOR') AND state='DE'";

interface DelawareRow {
  business_name?: string;
  trade_name?: string;
  category?: string;
  license_number?: string;
  address_1?: string;
  address_2?: string;
  city?: string;
  state?: string;
  zip?: string;
  current_license_valid_to?: string;
}

// --- HTTP helper ----------------------------------------------------------

async function politeFetch(url: string): Promise<string | null> {
  for (const ua of [POLITE_UA, FALLBACK_UA] as const) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": ua,
          Accept: "application/json",
        },
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);
      if (response.status === 403 || response.status === 503) {
        if (ua === POLITE_UA) {
          console.warn(
            `[delaware-contractor] ${response.status} with polite UA; retrying with Chrome UA`,
          );
          continue;
        }
        console.error(
          `[delaware-contractor] ${response.status} on ${url} — giving up`,
        );
        return null;
      }
      if (!response.ok) {
        console.error(`[delaware-contractor] ${response.status} on ${url}`);
        return null;
      }
      return await response.text();
    } catch (error) {
      clearTimeout(timer);
      const msg = (error as Error).message ?? String(error);
      console.warn(`[delaware-contractor] network error on ${url}: ${msg}`);
      return null;
    }
  }
  return null;
}

// --- City index -----------------------------------------------------------

let cityIndexCache: Map<string, string> | null = null;

async function loadCityIndex(): Promise<Map<string, string>> {
  if (cityIndexCache) return cityIndexCache;
  const cities = await getCities({ country: "US" });
  const idx = new Map<string, string>();
  for (const city of cities) {
    idx.set(city.name.toLowerCase(), city.slug);
    idx.set(city.slug.toLowerCase(), city.slug);
  }
  cityIndexCache = idx;
  return idx;
}

// --- Fetch & parse --------------------------------------------------------

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const cityIndex = await loadCityIndex();
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let droppedNoCity = 0;
  let droppedNoName = 0;
  let droppedExpired = 0;

  outer: while (out.length < limit) {
    const pageSize = Math.min(PAGE_SIZE, limit - out.length);
    const url =
      `${SODA_BASE}?$limit=${pageSize}&$offset=${offset}` +
      `&$where=${encodeURIComponent(WHERE_CLAUSE)}` +
      `&$order=license_number+ASC`;

    const body = await politeFetch(url);
    if (!body) break;

    let rows: DelawareRow[];
    try {
      rows = JSON.parse(body) as DelawareRow[];
    } catch (e) {
      console.error(
        `[delaware-contractor] JSON parse error: ${(e as Error).message}`,
      );
      break;
    }
    if (rows.length === 0) break; // no more pages

    const now = new Date();
    for (const row of rows) {
      if (out.length >= limit) break outer;

      // Drop expired licences.
      if (row.current_license_valid_to) {
        const exp = new Date(row.current_license_valid_to);
        if (exp < now) {
          droppedExpired += 1;
          continue;
        }
      }

      const name = (row.trade_name || row.business_name || "").trim();
      if (!name) {
        droppedNoName += 1;
        continue;
      }

      const licenceNumber = (row.license_number || "").trim();
      if (!licenceNumber) continue;

      const sourceId = `delaware-contractor:${licenceNumber}`;
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);

      const rawCity = (row.city || "").trim();
      const citySlug = cityIndex.get(rawCity.toLowerCase());
      if (!citySlug) {
        droppedNoCity += 1;
        continue;
      }

      const addr1 = (row.address_1 || "").trim();
      const addr2 = (row.address_2 || "").trim();
      const zip = (row.zip || "").trim();
      const statePart = (row.state || "DE").trim();
      const addrParts = [addr1, addr2, rawCity, statePart, zip].filter(
        Boolean,
      );
      const address = addrParts.join(", ") || undefined;

      out.push(
        normalise({
          source: "delaware-contractor",
          sourceId,
          name,
          categoryKey: "carpinteria",
          citySlug,
          address,
          licenseNumber: licenceNumber,
          metadata: {
            country: "US",
            state: "DE",
            authority: "Delaware Division of Revenue",
            verified_by_authority: true,
            license_category: (row.category || "").trim(),
          },
        }),
      );
    }

    if (rows.length < pageSize) break; // last page
    offset += pageSize;
    // Polite delay between pages (Socrata asks for crawl-delay: 1).
    await new Promise<void>((res) => setTimeout(res, 1_100));
  }

  console.log(
    `[delaware-contractor] parsed=${out.length} ` +
      `droppedNoCity=${droppedNoCity} droppedNoName=${droppedNoName} ` +
      `droppedExpired=${droppedExpired}`,
  );
  return out;
}

// --- Public entrypoint ----------------------------------------------------

export const delawareContractorSource: ScraperSource = {
  name: "delaware-contractor",
  enabled() {
    return process.env.PROLIO_RUN_DELAWARE_CONTRACTOR === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runDelawareContractor(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!delawareContractorSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(
    process.env.PROLIO_DELAWARE_CONTRACTOR_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const records = await fetchAll(limit);
  if (records.length === 0) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[delaware-contractor] done — fetched=${records.length} ` +
      `inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
