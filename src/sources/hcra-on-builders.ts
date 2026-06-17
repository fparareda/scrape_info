import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { toTitleCase } from "./_bulk-utils.js";

/**
 * HCRA — Home Construction Regulatory Authority (Ontario).
 *
 * Public builder directory at
 *   https://obd.hcraontario.ca/api/builders
 * Returns a JSON array of all licensed home builders and sellers in Ontario.
 * No pagination, no auth, no CAPTCHA. Single GET request returns all records.
 *
 * Pre-flight 2026-05-29 (datacenter IP):
 *   GET https://obd.hcraontario.ca/api/builders
 *     → 200 in ~2s, ~2.5 MB JSON, 48,142 records total.
 *     Active (Licensed + Licensed with Conditions): ~7,063 records.
 *     Fields: NAME, OPERATINGNAME, ACCOUNTNUMBER, ADDRESS_2_CITY,
 *             LICENSESTATUS, INSOLVENCY_INDICATOR
 *   robots.txt (obd.hcraontario.ca): `Disallow:` (no restrictions).
 *   robots.txt (hcraontario.ca): `Disallow:` (no restrictions).
 *
 * Category: `carpinteria` — home builders / residential construction
 * (closest taxonomy match for builder/seller licences; construction
 *  carpintería / builder is the canonical mapping used elsewhere).
 *
 * Province: ON (Ontario). Authority: HCRA.
 * Off by default — `PROLIO_RUN_HCRA_ON_BUILDERS=true` to enable.
 * Cap via `PROLIO_HCRA_ON_BUILDERS_LIMIT` (default 10_000; use a higher
 * value to ingest all ~7k active records in one pass).
 */

const API_URL = "https://obd.hcraontario.ca/api/builders";
const AUTHORITY = "HCRA";
const PROVINCE = "ON";
const CATEGORY: CategoryKey = "carpinteria";
const DEFAULT_CITY = "toronto"; // HCRA HQ city; used when city doesn't map
const DEFAULT_LIMIT = 10_000;
const REQUEST_TIMEOUT_MS = 60_000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

/**
 * Active licence statuses we ingest. Expired, Revoked, Refused etc. are
 * excluded — they represent ~85% of records and add noise to the directory.
 */
const ACTIVE_STATUSES = new Set([
  "Licensed",
  "Licensed with Conditions",
  "Licenced - NOP Under Appeal",
  "Licenced - NOP to Refuse a Licence",
  "Licenced - NOP to Revoke a Licence",
]);

/**
 * Map raw city strings (lowercase) from the HCRA dataset to seeded
 * city_slugs. Keys cover the top-30 cities by HCRA record count plus
 * Toronto's amalgamated-1998 boroughs (Scarborough, Etobicoke, North York,
 * East York, York) which collapse to `toronto`. Concord, Woodbridge,
 * Thornhill, Kleinburg are communities within Vaughan. Ancaster, Stoney Creek,
 * Dundas are amalgamated into Hamilton. Unknown cities fall back to `toronto`.
 */
const CITY_MAP: Record<string, string> = {
  // Toronto and amalgamated boroughs
  toronto: "toronto",
  "north york": "toronto",
  scarborough: "toronto",
  etobicoke: "toronto",
  "east york": "toronto",
  york: "toronto",
  "north york toronto": "toronto",
  // Peel / York / Durham / Halton
  mississauga: "mississauga",
  brampton: "brampton",
  markham: "markham",
  vaughan: "vaughan",
  concord: "vaughan",
  woodbridge: "vaughan",
  thornhill: "vaughan",
  kleinburg: "vaughan",
  maple: "vaughan",
  "richmond hill": "markham",
  aurora: "markham",
  newmarket: "markham",
  oakville: "mississauga",
  burlington: "mississauga",
  // Hamilton and amalgamated suburbs
  hamilton: "hamilton-ca",
  ancaster: "hamilton-ca",
  "stoney creek": "hamilton-ca",
  dundas: "hamilton-ca",
  // Other major Ontario cities
  ottawa: "ottawa",
  london: "london-ca",
  kitchener: "kitchener",
  waterloo: "kitchener",
  cambridge: "kitchener",
  guelph: "kitchener",
  windsor: "mississauga",   // no windsor slug; Mississauga is closest seeded city
  barrie: "markham",         // no barrie slug; use markham as nearest major ON city
  kingston: "ottawa",        // no kingston slug; use ottawa as nearest
  oshawa: "markham",         // no oshawa slug; use markham
  pickering: "markham",      // no pickering slug; use markham
  whitby: "markham",         // no whitby slug; use markham
  ajax: "markham",           // no ajax slug; use markham
  "thunder bay": "toronto",  // no thunder bay slug; default toronto
  sarnia: "london-ca",       // no sarnia slug; use london
  brantford: "hamilton-ca",  // no brantford slug; use hamilton
  "st. catharines": "mississauga",  // no st-catharines slug; use mississauga
  "niagara falls": "mississauga",   // no niagara-falls slug; use mississauga
  peterborough: "toronto",   // no peterborough slug; default toronto
  sudbury: "toronto",        // no sudbury slug; default toronto
};

function mapCity(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_CITY;
  const key = raw.trim().toLowerCase();
  return CITY_MAP[key] ?? DEFAULT_CITY;
}

interface HcraBuilderRow {
  NAME: string | null;
  OPERATINGNAME: string | null;
  ACCOUNTNUMBER: string | null;
  ADDRESS_2_CITY: string | null;
  LICENSESTATUS: string | null;
  INSOLVENCY_INDICATOR: string | null;
}

export const hcraOnBuildersSource: ScraperSource = {
  name: "hcra-on-builders" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_HCRA_ON_BUILDERS === "true";
  },
  async fetch() {
    return [];
  },
};

async function fetchBuilders(): Promise<HcraBuilderRow[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json,*/*",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(
        `[hcra-on-builders] HTTP ${res.status} fetching builder list`,
      );
      return null;
    }
    const data = await res.json() as unknown;
    if (!Array.isArray(data)) {
      console.warn("[hcra-on-builders] unexpected response shape (not array)");
      return null;
    }
    return data as HcraBuilderRow[];
  } catch (e) {
    console.warn(
      `[hcra-on-builders] fetch error: ${(e as Error).message}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function toRecord(row: HcraBuilderRow): ScrapedProfessional | null {
  const rawName = row.NAME ?? row.OPERATINGNAME;
  if (!rawName) return null;

  // Use operating name as display name when available (it's the trading name)
  const displayName = toTitleCase((row.OPERATINGNAME ?? rawName).trim());
  if (!displayName) return null;

  const accountNumber = row.ACCOUNTNUMBER?.trim() ?? "";
  const sourceId = accountNumber
    ? `hcra:${accountNumber}`
    : `hcra:name:${displayName.toLowerCase()}`;

  return normalise({
    source: "hcra-on-builders" as ScrapeSource,
    country: "CA",
    sourceId,
    name: displayName,
    categoryKey: CATEGORY,
    citySlug: mapCity(row.ADDRESS_2_CITY),
    licenseNumber: accountNumber || undefined,
    metadata: {
      country: "CA",
      province: PROVINCE,
      authority: AUTHORITY,
      verified_by_authority: true,
      license_status: row.LICENSESTATUS ?? null,
      insolvency_indicator: row.INSOLVENCY_INDICATOR ?? null,
      legal_name:
        row.OPERATINGNAME && row.NAME !== row.OPERATINGNAME
          ? toTitleCase(row.NAME?.trim() ?? "")
          : null,
    },
  });
}

export async function runHcraOnBuilders(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!hcraOnBuildersSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(
    process.env.PROLIO_HCRA_ON_BUILDERS_LIMIT ?? DEFAULT_LIMIT,
  );
  const cap =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const allRows = await fetchBuilders();
  if (!allRows) {
    console.warn(
      "[hcra-on-builders] fetched 0 records — endpoint may be down",
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  // Keep only active licences
  const activeRows = allRows.filter(
    (r) => r.LICENSESTATUS != null && ACTIVE_STATUSES.has(r.LICENSESTATUS),
  );
  console.log(
    `[hcra-on-builders] total=${allRows.length} active=${activeRows.length} cap=${cap}`,
  );

  const records: ScrapedProfessional[] = [];
  const seenSourceIds = new Set<string>();

  for (const row of activeRows) {
    if (records.length >= cap) break;
    const rec = toRecord(row);
    if (!rec) continue;
    if (seenSourceIds.has(rec.sourceId)) continue;
    seenSourceIds.add(rec.sourceId);
    records.push(rec);
  }

  if (records.length === 0) {
    console.warn(
      "[hcra-on-builders] 0 active records after filtering — endpoint may have changed",
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[hcra-on-builders] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
