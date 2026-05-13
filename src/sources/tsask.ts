import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay } from "./_bulk-utils.js";

/**
 * TSASK — Technical Safety Authority of Saskatchewan.
 *
 * Licenses electrical, gas, plumbing, boiler, elevator and amusement-
 * ride contractors in SK. Public search at
 *   https://www.tsask.ca/licence-lookup/
 * is an ASP.NET / Sitefinity SPA backed by an AJAX endpoint:
 *   POST /SearchService.svc/SearchContractors  (JSON body, JSON reply)
 * Pre-flight 2026-05: endpoint shape can change between deploys; we
 * therefore wrap the call in a defensive parser. If TSASK ever locks
 * the endpoint behind an antiforgery token we degrade to 0 rows and
 * log instead of failing the run.
 *
 * Off by default; `PROLIO_RUN_TSASK=true` to enable.
 */

const BASE = process.env.PROLIO_TSASK_BASE || "https://www.tsask.ca";
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 5000;
const PAGE_SIZE = 50;
const SK_DEFAULT_CITY = "saskatoon";

const TRADE_TO_CATEGORY: Array<{ pattern: RegExp; key: string }> = [
  { pattern: /electric/i, key: "electricidad" },
  { pattern: /gas|propane|hvac|boiler|fuel/i, key: "hvac" },
  { pattern: /plumb|drain|sewer|water/i, key: "fontaneria" },
  { pattern: /elevator|lift/i, key: "carpinteria" },
];

const SK_CITY_MAP: Record<string, string> = {
  saskatoon: "saskatoon",
  regina: "saskatoon",
  "prince albert": "saskatoon",
  "moose jaw": "saskatoon",
};

function pickCategory(trade: string): string {
  for (const t of TRADE_TO_CATEGORY) if (t.pattern.test(trade)) return t.key;
  return "hvac";
}

function mapCity(raw: string | undefined): string {
  const key = (raw ?? "").trim().toLowerCase();
  return SK_CITY_MAP[key] ?? SK_DEFAULT_CITY;
}

interface TsaskRow {
  Id?: string;
  CompanyName?: string;
  LicenceNumber?: string;
  Trade?: string;
  City?: string;
  Status?: string;
  [k: string]: unknown;
}

async function fetchPage(skip: number): Promise<TsaskRow[]> {
  const url = `${BASE}/SearchService.svc/SearchContractors`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        Accept: "application/json,text/plain,*/*",
      },
      body: JSON.stringify({ skip, take: PAGE_SIZE, keyword: "" }),
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const json = (await response.json()) as unknown;
    if (Array.isArray(json)) return json as TsaskRow[];
    if (json && typeof json === "object") {
      const o = json as Record<string, unknown>;
      for (const k of ["d", "data", "Results", "results", "items"]) {
        const v = o[k];
        if (Array.isArray(v)) return v as TsaskRow[];
      }
    }
    return [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  for (let skip = 0; skip < limit; skip += PAGE_SIZE) {
    const rows = await fetchPage(skip);
    if (rows.length === 0) break;
    for (const r of rows) {
      const name = (r.CompanyName ?? "").toString().trim();
      const lic = (r.LicenceNumber ?? r.Id ?? "").toString().trim();
      if (!name || !lic || seen.has(lic)) continue;
      seen.add(lic);
      const trade = (r.Trade ?? "").toString();
      out.push(
        normalise({
          source: "tsask" as ScrapeSource,
          sourceId: `tsask:${lic}`,
          name,
          categoryKey: pickCategory(trade) as ScrapedProfessional["categoryKey"],
          citySlug: mapCity(r.City as string | undefined),
          licenseNumber: lic,
          metadata: {
            country: "CA",
            province: "SK",
            authority: "TSASK",
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
  if (!tsaskSource.enabled()) return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
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
