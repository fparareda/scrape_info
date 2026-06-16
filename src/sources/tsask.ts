import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay } from "./_bulk-utils.js";

/**
 * TSASK — Technical Safety Authority of Saskatchewan.
 *
 * Public licence lookup at
 *   https://www.tsask.ca/licence-lookup/
 * is a WordPress front-end backed by a custom WP REST endpoint at
 *   https://api.tsask.ca/wp-json/licence/v1/licences
 *
 * Pre-flight 2026-05-13 (live):
 *   GET ?per_page=500&page=1
 *     -> meta.total = 23,219
 *     -> meta.total_pages = 47 at per_page=500
 *   Categories observed: Electrical Contractor, Gas Contractor,
 *   Elevator Contractor, Elevator Mechanic, Quality Control Program
 *   Technologies: electrical, gas, elevating-devices,
 *   boilers-and-pressure-vessels
 *
 * Strategy: enumerate all pages (no filter needed — the endpoint
 * returns every category). Filter out placeholder/draft rows that
 * carry empty `name` AND empty `licence_number`. Map each row's
 * `technology` to a Prolio category. Records include city, province,
 * expiry date, restriction text and subtype.
 *
 * Off by default; `PROLIO_RUN_TSASK=true`. Cap with `PROLIO_TSASK_LIMIT`
 * (default 25000 — covers full sweep with headroom).
 */

const ENDPOINT = "https://api.tsask.ca/wp-json/licence/v1/licences";
const REFERER = "https://www.tsask.ca/";
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 25_000;
const PAGE_SIZE = 500;
const REQUEST_DELAY_MS = 400;
// Hard ceiling on pages enumerated, regardless of meta. The known
// dataset is ~23k rows = ~47 pages at PAGE_SIZE=500; 100 leaves ample
// headroom for growth while guaranteeing termination if the endpoint
// changes (e.g. starts ignoring `page` and returning a full page of
// identical rows, which would otherwise spin forever since the dedup
// set keeps `out.length` below `limit`). See oec-fr's MAX_PAGES pattern.
const MAX_PAGES = 100;

const TECH_TO_CATEGORY: Record<string, string> = {
  electrical: "electricidad",
  gas: "hvac",
  "elevating-devices": "carpinteria", // closest taxonomy slot for lift/elevator install
  "boilers-and-pressure-vessels": "hvac",
};

const SK_CITY_WHITELIST = new Set<string>([
  "saskatoon",
  "regina",
]);

function mapCity(raw: string | null | undefined): string {
  if (!raw) return "saskatoon";
  const k = raw.toLowerCase().trim();
  return SK_CITY_WHITELIST.has(k) ? k : "saskatoon";
}

function pickCategory(tech: string | null | undefined): string {
  if (!tech) return "hvac";
  return TECH_TO_CATEGORY[tech] || "hvac";
}

interface TsaskLicence {
  id: number;
  category?: string;
  technology?: string;
  name?: string | null;
  last_name?: string | null;
  licence_number?: string | null;
  expiry_date?: string | null;
  expiry_date_formatted?: string | null;
  expiry_date_timestamp?: number | null;
  subtype?: string | null;
  restriction?: string | null;
  city?: string | null;
  province?: string | null;
}

interface TsaskMeta {
  total: number;
  total_pages: number;
  current_page: number;
  per_page: number;
}

interface TsaskResponse {
  results?: TsaskLicence[];
  meta?: TsaskMeta;
}

async function fetchPage(page: number): Promise<TsaskResponse | null> {
  const url = `${ENDPOINT}?per_page=${PAGE_SIZE}&page=${page}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        Origin: "https://www.tsask.ca",
        Referer: REFERER,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[tsask] ${res.status} on page=${page}`);
      return null;
    }
    return (await res.json()) as TsaskResponse;
  } catch (err) {
    console.warn(
      `[tsask] network error on page=${page}: ${(err as Error).message}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function buildDisplayName(r: TsaskLicence): string {
  // The endpoint returns either company names in `name` (with
  // `last_name` null) or person rows where both fields are populated.
  const name = (r.name || "").trim();
  const last = (r.last_name || "").trim();
  if (name && last) return `${name} ${last}`;
  return name || last;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let page = 1;
  let totalPages: number | undefined;
  let total: number | undefined;
  while (out.length < limit && page <= MAX_PAGES) {
    const data = await fetchPage(page);
    if (!data || !data.results || data.results.length === 0) break;
    if (totalPages === undefined && data.meta) {
      totalPages = data.meta.total_pages;
      total = data.meta.total;
      console.log(`[tsask] total=${total} pages=${totalPages}`);
    }
    const beforePage = out.length;
    for (const r of data.results) {
      const displayName = buildDisplayName(r);
      const licenceNumber = (r.licence_number || "").trim();
      // Filter placeholder/draft rows that carry neither identifier.
      if (!displayName || !licenceNumber) continue;
      const key = `tsask:${licenceNumber}:${r.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(
        normalise({
          source: "tsask" as ScrapeSource,
          country: "CA",
          sourceId: key,
          name: displayName,
          categoryKey: pickCategory(r.technology) as never,
          citySlug: mapCity(r.city),
          licenseNumber: licenceNumber,
          metadata: {
            country: "CA",
            province: "SK",
            authority: "TSASK",
            verified_by_authority: true,
            category_label: r.category,
            technology: r.technology,
            subtype: r.subtype,
            restriction: r.restriction || undefined,
            expiry_date: r.expiry_date_formatted || r.expiry_date || undefined,
            raw_city: r.city,
            raw_province: r.province,
          },
        }),
      );
      if (out.length >= limit) return out;
    }
    if (data.results.length < PAGE_SIZE) break;
    if (totalPages !== undefined && page >= totalPages) break;
    // Guard against a changed endpoint that ignores `page` and returns
    // the same full page repeatedly: if a full page yielded no new
    // records (all duplicates or all filtered), further pages won't
    // either, so stop rather than spin until the CI timeout.
    if (out.length === beforePage) {
      console.warn(
        `[tsask] page=${page} returned ${data.results.length} rows but 0 new — stopping (endpoint may ignore paging)`,
      );
      break;
    }
    page += 1;
    await delay(REQUEST_DELAY_MS);
  }
  return out;
}

export const tsaskSource: ScraperSource = {
  name: "tsask" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_TSASK === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runTsask(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!tsaskSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const limit = Number(process.env.PROLIO_TSASK_LIMIT ?? DEFAULT_LIMIT);
  const cap = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
  const records = await fetchAll(cap);
  if (records.length === 0) {
    console.warn("[tsask] no rows fetched — endpoint may have changed");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[tsask] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
