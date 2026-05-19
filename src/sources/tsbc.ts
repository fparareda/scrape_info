import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay } from "./_bulk-utils.js";

/**
 * TSBC — Technical Safety BC.
 *
 * Licenses contractors in BC for electrical / gas / amusement-device /
 * elevating-device categories. Public lookup at
 *   https://www.technicalsafetybc.ca/regulatory-resources/find-a-licensed-contractor
 * is backed by a clean JSON endpoint at
 *   https://www.technicalsafetybc.ca/api/findalicensedcontractor/query
 *
 * Pre-flight 2026-05-13 (live):
 *   ?technology=Electrical          → num_results=6,388
 *   ?technology=Gas                 → num_results=4,100
 *   ?technology=Amusement%20Devices → num_results=189
 *   ?technology=Elevating%20Devices → num_results=57
 *   Total reachable: ~10,734 BC-licensed contractors.
 *
 * Page size is 1000. Pagination via `?page=N`. `technology` is
 * required — empty filter returns 0. Boiler / Refrigeration /
 * Pressure not surfaced as standalone categories (folded into Gas /
 * Elevating).
 *
 * Records include company_name, license_number, license_class,
 * license_status, city/province/postal_code, business_phone, email,
 * license_issue_date/license_expiry_date. Some contractors are based
 * outside BC (Alberta, Ontario) but TSBC-licensed — preserved with
 * declared province in metadata.
 *
 * Off by default; `PROLIO_RUN_TSBC=true`. Cap with `PROLIO_TSBC_LIMIT`
 * (default 12000 — covers full sweep with headroom).
 */

const ENDPOINT =
  "https://www.technicalsafetybc.ca/api/findalicensedcontractor/query";
const REFERER =
  "https://www.technicalsafetybc.ca/regulatory-resources/find-a-licensed-contractor";
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 12_000;
const PAGE_SIZE = 1000;
const REQUEST_DELAY_MS = 500;

// Verified live 2026-05-13. Order = priority (most populated first).
const TECHNOLOGIES = [
  "Electrical",
  "Gas",
  "Amusement Devices",
  "Elevating Devices",
] as const;

const TECH_TO_CATEGORY: Record<string, string> = {
  Electrical: "electricidad",
  Gas: "hvac",
  "Amusement Devices": "mecanica",
  "Elevating Devices": "carpinteria",
};

const BC_CITY_WHITELIST = new Set<string>([
  "vancouver",
  "surrey",
  "burnaby",
  "richmond",
  "victoria",
  "abbotsford",
  "coquitlam",
  "kelowna",
]);

function mapCity(raw: string | undefined): string {
  if (!raw) return "vancouver";
  const k = raw.toLowerCase().trim();
  return BC_CITY_WHITELIST.has(k) ? k : "vancouver";
}

interface TsbcContractor {
  id: string;
  company_name: string;
  license_number: string;
  license_class?: string;
  license_status?: string;
  license_issue_date?: string;
  license_expiry_date?: string;
  technology: string;
  city?: string;
  province?: string;
  country?: string;
  postal_code?: string;
  business_phone?: string;
  home_phone?: string;
  other_phone?: string;
  email?: string;
  website?: string;
  qualifications?: string;
  enforcement_actions?: unknown[];
  account_id?: string;
}

interface TsbcResponse {
  msg?: string;
  num_results?: number;
  results?: TsbcContractor[];
}

async function fetchPage(
  technology: string,
  page: number,
): Promise<TsbcResponse | null> {
  const url =
    `${ENDPOINT}?technology=${encodeURIComponent(technology)}` +
    `&company_name=&license_number=&page=${page}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        Referer: REFERER,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[tsbc] ${res.status} on ${technology} page=${page}`);
      return null;
    }
    return (await res.json()) as TsbcResponse;
  } catch (err) {
    console.warn(
      `[tsbc] network error on ${technology} page=${page}: ${(err as Error).message}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function bestPhone(c: TsbcContractor): string | undefined {
  return c.business_phone || c.home_phone || c.other_phone || undefined;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  for (const tech of TECHNOLOGIES) {
    if (out.length >= limit) break;
    let page = 1;
    let total: number | undefined;
    while (out.length < limit) {
      const data = await fetchPage(tech, page);
      if (!data || !data.results || data.results.length === 0) break;
      if (total === undefined && typeof data.num_results === "number") {
        total = data.num_results;
        console.log(`[tsbc] ${tech}: total=${total}`);
      }
      for (const c of data.results) {
        const key = `tsbc:${c.license_number || c.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const category = TECH_TO_CATEGORY[c.technology] || "hvac";
        out.push(
          normalise({
            source: "tsbc" as ScrapeSource,
            country: "CA",
            sourceId: key,
            name: c.company_name,
            categoryKey: category as never,
            citySlug: mapCity(c.city),
            licenseNumber: c.license_number || undefined,
            phone: bestPhone(c),
            email: c.email || undefined,
            website: c.website || undefined,
            metadata: {
              country: "CA",
              province: "BC",
              authority: "TSBC",
              verified_by_authority: true,
              technology: c.technology,
              license_class: c.license_class,
              license_status: c.license_status,
              license_issue_date: c.license_issue_date,
              license_expiry_date: c.license_expiry_date,
              raw_city: c.city,
              raw_province: c.province,
              postal_code: c.postal_code,
              qualifications: c.qualifications,
              enforcement_count: Array.isArray(c.enforcement_actions)
                ? c.enforcement_actions.length
                : 0,
            },
          }),
        );
        if (out.length >= limit) break;
      }
      const fetchedFromThisPage = data.results.length;
      if (fetchedFromThisPage < PAGE_SIZE) break;
      if (total !== undefined && page * PAGE_SIZE >= total) break;
      page += 1;
      await delay(REQUEST_DELAY_MS);
    }
  }
  return out;
}

export const tsbcSource: ScraperSource = {
  name: "tsbc" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_TSBC === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runTsbc(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!tsbcSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const limit = Number(process.env.PROLIO_TSBC_LIMIT ?? DEFAULT_LIMIT);
  const cap = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
  const records = await fetchAll(cap);
  if (records.length === 0) {
    console.warn("[tsbc] no rows fetched — endpoint may have changed");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[tsbc] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
