import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { parseCsv, pick, normaliseNorthAmericanPhone } from "./_bulk-utils.js";

/**
 * City of Toronto — Municipal Licensing & Standards "Business Licences
 * and Permits" (Open Data, CKAN).
 *
 * Catalog page:
 *   https://open.toronto.ca/dataset/
 *     municipal-licensing-and-standards-business-licences-and-permits/
 *
 * Package (CKAN, no auth):
 *   https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/
 *     package_show?id=municipal-licensing-and-standards-business-
 *     licences-and-permits
 *
 * Direct CSV resource (curl-verified 2026-05-18, HTTP/2 200):
 *   https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/
 *     57b2285f-4f80-45fb-ae3e-41a02c3a137f/resource/
 *     54bddc5e-92d9-4102-89c1-43e82f8f4d2d/download/
 *     business-licences-data.csv
 *
 * Columns:
 *   _id,Category,Licence No.,Operating Name,Issued,Client Name,
 *   Business Phone,Business Phone Ext.,Licence Address Line 1,
 *   Licence Address Line 2,Licence Address Line 3,Ward,Conditions,
 *   Free Form Conditions Line 1,Free Form Conditions Line 2,
 *   Plate No.,Endorsements,Cancel Date,Last Record Update
 *
 * Universe: ~70k licences (active + cancelled). We keep rows whose
 * Cancel Date is empty (active) and whose Category maps to a prolio
 * CategoryKey. Realistic landing ~3k–10k mapped (most rows are
 * taxis/limos/PTC which don't map to any CategoryKey).
 *
 * Env:
 *   PROLIO_RUN_TORONTO_BUSINESS_LICENSES=true       enable
 *   PROLIO_TORONTO_BUSINESS_LICENSES_LIMIT=100000   cap (default)
 *   PROLIO_TORONTO_RESOURCE_ID=<override>           pin a resource id
 */

const DEFAULT_LIMIT = 100_000;
const DEFAULT_RESOURCE_URL =
  "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/" +
  "57b2285f-4f80-45fb-ae3e-41a02c3a137f/resource/" +
  "54bddc5e-92d9-4102-89c1-43e82f8f4d2d/download/business-licences-data.csv";
const CKAN_SHOW =
  "https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/" +
  "package_show?id=municipal-licensing-and-standards-business-" +
  "licences-and-permits";
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

const CATEGORY_MAP: Record<string, CategoryKey> = {
  // Toronto MLS uses ALL-CAPS, semi-stable category labels.
  "ELECTRICAL CONTRACTOR": "electricidad",
  ELECTRICIAN: "electricidad",
  "MASTER ELECTRICIAN": "electricidad",
  "PLUMBING CONTRACTOR": "fontaneria",
  PLUMBER: "fontaneria",
  "DRAIN CONTRACTOR": "fontaneria",
  "DRAIN LAYER": "fontaneria",
  "HEATING CONTRACTOR": "hvac",
  "AIR CONDITIONING CONTRACTOR": "hvac",
  "HVAC CONTRACTOR": "hvac",
  "REFRIGERATION CONTRACTOR": "hvac",
  CARPENTER: "carpinteria",
  "WOOD WORKING CONTRACTOR": "carpinteria",
  PHARMACY: "farmacia",
  "DRUG STORE": "farmacia",
  "VEHICLE DEALER": "mecanica",
  "AUTO BODY REPAIR SHOP": "mecanica",
  "AUTOMOBILE SERVICE STATION": "mecanica",
  "AUTOMOBILE REPAIR SHOP": "mecanica",
  "MOTOR VEHICLE REPAIR SHOP": "mecanica",
  "VEHICLE REPAIR": "mecanica",
  LOCKSMITH: "cerrajero",
  "TOWING SERVICE": "mecanica",
};

function mapCategory(cat: string): CategoryKey | undefined {
  const norm = cat.trim().toUpperCase();
  if (CATEGORY_MAP[norm]) return CATEGORY_MAP[norm];
  for (const key of Object.keys(CATEGORY_MAP)) {
    if (norm.includes(key)) return CATEGORY_MAP[key];
  }
  return undefined;
}

/**
 * Re-discover the active CSV resource via CKAN package_show. The
 * resource id is stable across years but the City has rotated it twice
 * in the past (latest 2025-12). Falls back to the hard-coded URL when
 * the catalog endpoint is unreachable.
 */
async function discoverCsvUrl(): Promise<string> {
  const pinned = process.env.PROLIO_TORONTO_RESOURCE_ID;
  if (pinned) {
    return (
      "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/" +
      "57b2285f-4f80-45fb-ae3e-41a02c3a137f/resource/" +
      `${pinned}/download/business-licences-data.csv`
    );
  }
  try {
    const r = await fetch(CKAN_SHOW, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) return DEFAULT_RESOURCE_URL;
    const j = (await r.json()) as {
      result?: { resources?: Array<{ format?: string; url?: string; name?: string }> };
    };
    const resources = j.result?.resources ?? [];
    // Prefer the "Business licences data.csv" entry (lowercase 'csv'
    // ending, non-empty); the readme XLS uses ".xls".
    const csvs = resources.filter(
      (res) =>
        (res.format || "").toUpperCase() === "CSV" &&
        (res.url || "").endsWith(".csv"),
    );
    if (csvs.length === 0) return DEFAULT_RESOURCE_URL;
    // Pick the largest by URL filename heuristic (data.csv > readme.csv).
    const main =
      csvs.find((r) => (r.url || "").includes("business-licences-data.csv")) ||
      csvs.find((r) => (r.url || "").includes("business.licences.csv")) ||
      csvs[0];
    return main.url || DEFAULT_RESOURCE_URL;
  } catch {
    return DEFAULT_RESOURCE_URL;
  }
}

export const torontoBusinessLicensesSource: ScraperSource = {
  name: "toronto-business-licenses" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_TORONTO_BUSINESS_LICENSES === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runTorontoBusinessLicenses(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!torontoBusinessLicensesSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(
    process.env.PROLIO_TORONTO_BUSINESS_LICENSES_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const url = await discoverCsvUrl();
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/csv" },
      signal: AbortSignal.timeout(240_000),
    });
  } catch (e) {
    console.error(
      `[toronto-business-licenses] network: ${(e as Error).message}`,
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  if (!response.ok) {
    console.error(
      `[toronto-business-licenses] ${response.status} on ${url}`,
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const text = await response.text();
  const rows = parseCsv(text);
  console.log(
    `[toronto-business-licenses] parsed raw=${rows.length} from CSV`,
  );

  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (out.length >= limit) break;
    const cancel = pick(row, ["cancel_date"]);
    if (cancel) continue; // skip cancelled
    const cat = mapCategory(pick(row, ["category"]));
    if (!cat) continue;
    const licence = pick(row, ["licence_no", "licence_no_"]);
    if (!licence || seen.has(licence)) continue;
    seen.add(licence);
    const name =
      pick(row, ["operating_name"]) || pick(row, ["client_name"]);
    if (!name) continue;
    const line1 = pick(row, ["licence_address_line_1"]);
    const line2 = pick(row, ["licence_address_line_2"]);
    const line3 = pick(row, ["licence_address_line_3"]);
    const address = [line1, line2, line3].filter(Boolean).join(", ");

    out.push(
      normalise({
        source: "toronto-business-licenses",
        sourceId: `toronto-business-licenses:${licence}`,
        name,
        categoryKey: cat,
        citySlug: "toronto",
        phone: normaliseNorthAmericanPhone(pick(row, ["business_phone"])),
        address: address || undefined,
        licenseNumber: licence,
        metadata: {
          country: "CA",
          province: "ON",
          authority: "City of Toronto — Municipal Licensing & Standards",
          verified_by_authority: true,
          category_raw: pick(row, ["category"]),
          ward: pick(row, ["ward"]),
          issued: pick(row, ["issued"]),
          endorsements: pick(row, ["endorsements"]),
        },
      }),
    );
  }

  const sink = getSink();
  const res = await sink.upsert(out);
  console.log(
    `[toronto-business-licenses] done — fetched=${out.length} ` +
      `inserted=${res.inserted} updated=${res.updated} skipped=${res.skipped}`,
  );
  return {
    fetched: out.length,
    inserted: res.inserted,
    updated: res.updated,
    skipped: res.skipped,
  };
}
