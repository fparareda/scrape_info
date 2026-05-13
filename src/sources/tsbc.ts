import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay } from "./_bulk-utils.js";

/**
 * TSBC — Technical Safety BC.
 *
 * Licenses contractors in BC for electrical, gas, boiler, refrigeration,
 * elevator and amusement-device categories. The "Find a Licensed
 * Contractor" tool at
 *   https://www.technicalsafetybc.ca/regulatory-resources/find-a-licensed-contractor
 * issues XHR to an Azure-backed JSON endpoint. We probe a small set of
 * known endpoints and degrade gracefully if none respond.
 *
 * Off by default; `PROLIO_RUN_TSBC=true`.
 */

const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 5000;
const PAGE_SIZE = 100;
const BASE = "https://www.technicalsafetybc.ca";

const TRADE_TO_CATEGORY: Array<{ pattern: RegExp; key: string }> = [
  { pattern: /electric/i, key: "electricidad" },
  { pattern: /gas|propane|hvac|boiler|fuel|refriger/i, key: "hvac" },
  { pattern: /plumb|drain|sewer|water/i, key: "fontaneria" },
  { pattern: /elevator|lift/i, key: "carpinteria" },
];

const BC_CITIES = new Set<string>([
  "vancouver","surrey","burnaby","richmond","victoria","abbotsford",
  "coquitlam","kelowna",
]);

function pickCategory(trade: string): string {
  for (const t of TRADE_TO_CATEGORY) if (t.pattern.test(trade)) return t.key;
  return "hvac";
}

function mapCity(raw: string | undefined): string {
  if (!raw) return "vancouver";
  const k = raw.toLowerCase().trim();
  return BC_CITIES.has(k) ? k : "vancouver";
}

const CANDIDATE_ENDPOINTS = [
  `${BASE}/api/contractor-search?page={p}&pageSize=${PAGE_SIZE}`,
  `${BASE}/api/contractors/search?skip={s}&take=${PAGE_SIZE}`,
  `${BASE}/regulatory-resources/find-a-licensed-contractor/_jcr_content.contractors.json?page={p}`,
];

interface TsbcRow {
  CompanyName?: string;
  BusinessName?: string;
  LicenceNumber?: string;
  LicenseNumber?: string;
  City?: string;
  Trade?: string;
  Discipline?: string;
  Status?: string;
  [k: string]: unknown;
}

async function fetchOnePage(page: number): Promise<TsbcRow[]> {
  const skip = (page - 1) * PAGE_SIZE;
  for (const tmpl of CANDIDATE_ENDPOINTS) {
    const url = tmpl.replace("{p}", String(page)).replace("{s}", String(skip));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json,*/*" },
        signal: controller.signal,
      });
      if (!response.ok) continue;
      const ct = response.headers.get("content-type") || "";
      if (!ct.includes("json")) continue;
      const json = (await response.json()) as unknown;
      if (Array.isArray(json)) return json as TsbcRow[];
      if (json && typeof json === "object") {
        const o = json as Record<string, unknown>;
        for (const k of ["data", "results", "items", "Contractors"]) {
          const v = o[k];
          if (Array.isArray(v)) return v as TsbcRow[];
        }
      }
    } catch {
      /* try next */
    } finally {
      clearTimeout(timer);
    }
  }
  return [];
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  for (let page = 1; out.length < limit; page += 1) {
    const rows = await fetchOnePage(page);
    if (rows.length === 0) break;
    for (const r of rows) {
      const name = (r.CompanyName ?? r.BusinessName ?? "").toString().trim();
      const lic = (r.LicenceNumber ?? r.LicenseNumber ?? "").toString().trim();
      if (!name || !lic || seen.has(lic)) continue;
      seen.add(lic);
      const trade = (r.Trade ?? r.Discipline ?? "").toString();
      out.push(
        normalise({
          source: "tssa" as ScrapeSource, // reuse existing source name; metadata.authority distinguishes
          sourceId: `tsbc:${lic}`,
          name,
          categoryKey: pickCategory(trade) as ScrapedProfessional["categoryKey"],
          citySlug: mapCity(r.City as string | undefined),
          licenseNumber: lic,
          metadata: {
            country: "CA",
            province: "BC",
            authority: "TSBC",
            verified_by_authority: true,
            trade,
            status: r.Status,
          },
        }),
      );
      if (out.length >= limit) return out;
    }
    if (rows.length < PAGE_SIZE) break;
    await delay(1000);
  }
  return out;
}

export const tsbcSource: ScraperSource = {
  name: "tssa" as ScrapeSource,
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
  if (!tsbcSource.enabled()) return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
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
